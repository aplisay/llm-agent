import { createHmac } from 'crypto';
import logger from './logger.js';

/**
 * @typedef {Object} CallHookConfig
 * @property {string} url - URL to call (required)
 * @property {string} [hashKey] - Optional shared secret used to compute hash
 * @property {boolean} [includeTranscript] - If true, include transcript on end event
 * @property {('start'|'end')[]} [events] - Events to trigger on (defaults to ['start','end'])
 */

/**
 * Resolve the effective callHook configuration for a call.
 * Listener/Instance-level configuration takes precedence over Agent-level.
 *
 * @param {object} params
 * @param {object} params.agent - Agent object (may be Sequelize model or plain object)
 * @param {object} [params.listenerOrInstance] - Instance/listener object (may be Sequelize model or plain object)
 * @returns {CallHookConfig|null}
 */
export function resolveCallHook({ agent, listenerOrInstance }) {
  if (!agent && !listenerOrInstance) return null;

  const instanceHook = listenerOrInstance?.metadata?.callHook || listenerOrInstance?.options?.callHook;
  const agentHook = agent?.options?.callHook;

  const hook = instanceHook || agentHook;

  if (!hook || !hook.url) return null;

  // Normalise events: default to both start and end
  const events = Array.isArray(hook.events) && hook.events.length
    ? hook.events
    : ['start', 'end'];

  return {
    url: hook.url,
    hashKey: hook.hashKey,
    includeTranscript: !!hook.includeTranscript,
    events,
  };
}

/**
 * Compute the HMAC-SHA256 hash over hashKey + callId + listenerId + agentId.
 *
 * @param {object} params
 * @param {string} params.hashKey
 * @param {string} params.callId
 * @param {string} [params.listenerId]
 * @param {string} [params.agentId]
 * @returns {string}
 */
export function signCallHookPayload({ hashKey, callId, listenerId, agentId }) {
  const canonical = `${hashKey}|${callId}|${listenerId || ''}|${agentId || ''}`;
  const hmac = createHmac('sha256', hashKey);
  hmac.update(canonical);
  return hmac.digest('hex');
}

/**
 * Lazily fetch transcript logs for a call from TransactionLog.
 * Prefer final logs if present; otherwise return all logs.
 *
 * @param {string} callId
 * @returns {Promise<{entries: Array<{type: string, data: any, isFinal?: boolean, createdAt: Date}>}>}
 */
export async function fetchTranscriptForCall(callId) {
  if (!callId) return null;

  try {
    // Lazy-load TransactionLog to avoid initialising the database connection
    // in contexts (like unit tests) that only exercise helper functions.
    const { TransactionLog } = await import('./database.js');

    const logs = await TransactionLog.findAll({
      where: { callId },
      order: [['createdAt', 'ASC']],
    });

    if (!logs || !logs.length) return null;

    const finalLogs = logs.filter(l => l.isFinal);
    const usedLogs = finalLogs.length ? finalLogs : logs;

    return {
      entries: usedLogs.map(l => ({
        type: l.type,
        data: l.data,
        isFinal: l.isFinal,
        createdAt: l.createdAt,
      })),
    };
  } catch (err) {
    logger.warn({ err, callId }, 'call-hook: failed to fetch transcript from TransactionLog');
    return null;
  }
}

/**
 * Build the JSON payload for a callHook callback.
 *
 * @param {object} params
 * @param {'start'|'end'} params.event
 * @param {object} params.call
 * @param {object} params.agent
 * @param {object} [params.listenerOrInstance]
 * @param {string} [params.reason]
 * @param {object|null} [params.transcript]
 * @returns {object}
 */
export function buildCallHookPayload({
  event,
  call,
  agent,
  listenerOrInstance,
  reason,
  transcript,
}) {
  const callId = call?.id;
  const agentId = agent?.id || call?.agentId;
  const listenerId = listenerOrInstance?.id || call?.instanceId;

  const base = {
    event,
    callId,
    agentId,
    listenerId,
    callerId: call?.callerId,
    calledId: call?.calledId,
    timestamp: new Date().toISOString(),
  };

  if (event === 'end') {
    const durationSeconds = typeof call?.duration === 'number'
      ? Math.round(call.duration / 1000)
      : undefined;

    return {
      ...base,
      reason,
      durationSeconds,
      ...(transcript ? { transcript } : {}),
    };
  }

  return base;
}

/**
 * Perform the HTTP POST to the callHook URL.
 *
 * @param {object} params
 * @param {CallHookConfig} params.callHook
 * @param {object} params.payload
 * @param {import('pino').Logger | Console} [params.logger]
 * @returns {Promise<void>}
 */
export async function sendCallHook({ callHook, payload, logger: log = logger }) {
  if (!callHook?.url) return;

  const controller = new AbortController();
  const timeoutMs = 5000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(callHook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(
        {
          url: callHook.url,
          status: res.status,
          statusText: res.statusText,
          bodySnippet: text?.slice(0, 200),
        },
        'call-hook: callback failed'
      );
    } else {
      log.debug(
        { url: callHook.url, status: res.status },
        'call-hook: callback sent'
      );
    }
  } catch (err) {
    log.warn({ err, url: callHook.url }, 'call-hook: error sending callback');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * High-level helper that resolves the callHook, optionally fetches transcript,
 * signs the payload, and sends the callback.
 *
 * @param {object} params
 * @param {'start'|'end'} params.event
 * @param {object} params.call
 * @param {object} params.agent
 * @param {object} [params.listenerOrInstance]
 * @param {string} [params.reason]
 * @param {object|null} [params.transcript] - Precomputed transcript; if absent and includeTranscript is true, we will lazily fetch it.
 * @param {import('pino').Logger | Console} [params.logger]
 */
export async function maybeSendCallHook({
  event,
  call,
  agent,
  listenerOrInstance,
  reason,
  transcript,
  logger: log = logger,
}) {
  try {
    // We may be passed plain objects; attempt to hydrate associations if needed.
    let resolvedAgent = agent;
    let resolvedInstance = listenerOrInstance;

    // If we only have a Call model, try to use Sequelize accessors to fetch Agent/Instance if not already provided.
    if (call && (!resolvedAgent || !resolvedInstance)) {
      try {
        if (!resolvedAgent && typeof call.getAgent === 'function') {
          resolvedAgent = await call.getAgent();
        }
      } catch (e) {
        log.debug({ e }, 'call-hook: unable to get Agent from call');
      }
      try {
        if (!resolvedInstance && typeof call.getInstance === 'function') {
          resolvedInstance = await call.getInstance();
        }
      } catch (e) {
        log.debug({ e }, 'call-hook: unable to get Instance from call');
      }
    }

    const hook = resolveCallHook({
      agent: resolvedAgent,
      listenerOrInstance: resolvedInstance,
    });

    if (!hook) {
      return;
    }

    if (!hook.events.includes(event)) {
      return;
    }

    let finalTranscript = transcript;
    if (event === 'end' && hook.includeTranscript && !finalTranscript && call?.id) {
      finalTranscript = await fetchTranscriptForCall(call.id);
    }

    const payload = buildCallHookPayload({
      event,
      call,
      agent: resolvedAgent,
      listenerOrInstance: resolvedInstance,
      reason,
      transcript: finalTranscript,
    });

    if (hook.hashKey && payload.callId) {
      payload.hash = signCallHookPayload({
        hashKey: hook.hashKey,
        callId: payload.callId,
        listenerId: payload.listenerId,
        agentId: payload.agentId,
      });
    }

    await sendCallHook({ callHook: hook, payload, logger: log });
  } catch (err) {
    // Never let callback errors bubble into call flows.
    logger.warn({ err, event, callId: call?.id }, 'call-hook: maybeSendCallHook failed');
  }
}


