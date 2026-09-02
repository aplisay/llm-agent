const {
  PIPECAT_WORKER_URL,
  PIPECAT_DISPATCH_TOKEN,
  PIPECAT_JOIN_SECRET,
  PIPECAT_PUBLIC_URL,
} = process.env;

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import defaultLogger from '../logger.js';
import Handler from './handler.js';
import PipecatModel from '../models/pipecat.js';
import UltravoxHandler from './ultravox.js';
import { Call } from '../database.js';
import { AgentConcurrencyLimitExceededError } from '../concurrency/agent-concurrency-limits.js';

/**
 * Pipecat handler. Replicates the contract documented in
 * docs/livekit-agent-architecture.md but talks to a self-contained Pipecat worker
 * over HTTP instead of LiveKit's AgentDispatchClient. The worker uses Daily as a
 * pure SIP gateway for telephony and SmallWebRTCTransport for browser clients;
 * the gateway is abstracted in the worker so it can be swapped (e.g. FreeSWITCH)
 * without touching this handler.
 */
class Pipecat extends Handler {
  static name = 'pipecat';
  static description = 'Pipecat';

  // Required for new handlers per section 5.5 of the architecture doc.
  static hasDynamicMetadata = true;
  static hasWebRTC = true;
  static hasTelephony = true;
  static hasTransfer = true;
  // In-call agent handover (builtin transfer_agent) and text subagent
  // invocation (builtin subagent) are implemented in the Python worker —
  // see pipecat_aplisay/call_session.py. Note: not available on Ultravox
  // realtime models (one-shot /calls sessions can't swap prompt or tools).
  static hasAgentTransfer = true;
  static hasSubagent = true;
  // Send out-of-band (RFC 4733) DTMF over the SIP leg — the gateway (sipbridge /
  // voiceblender) synthesises telephone-event RTP; browser/WebRTC sessions error.
  static hasDtmf = true;

  static get models() {
    return [PipecatModel];
  }

  static needKey = {
    PIPECAT_WORKER_URL,
    PIPECAT_DISPATCH_TOKEN,
    PIPECAT_JOIN_SECRET,
    PIPECAT_PUBLIC_URL,
  };

  // Realtime voice catalog — one entry per realtime provider.
  // Pipeline TTS voices are *not* listed here; they come from the platform's
  // Voices index (lib/voices) via the pipecat branch in lib/model-voices.js.
  //
  // Voices are keyed under the `'any'` locale because OpenAI Realtime, Gemini
  // Live, and Ultravox all produce locale-neutral output — the model speaks
  // the language of the conversation regardless of the chosen voice timbre.
  // The locale-fallback logic in lib/model-voices.js exposes them under any
  // requested locale.
  //
  // Ultravox voices are merged in from the existing Ultravox handler, which
  // pulls the catalogue dynamically from the Ultravox API; the same voice
  // names are accepted by Pipecat's UltravoxRealtimeLLMService.
  static voices = (async () => {
    let ultravoxVoices = {};
    try {
      ultravoxVoices = await UltravoxHandler.voices;
    } catch (e) {
      defaultLogger.warn(
        { error: e?.message },
        'failed to load Ultravox voices for Pipecat handler — Ultravox voices will be unavailable',
      );
    }
    return {
      OpenAI: {
        any: [
          { name: 'alloy', description: 'Alloy', gender: 'female' },
          { name: 'ash', description: 'Ash', gender: 'male' },
          { name: 'ballad', description: 'Ballad', gender: 'male' },
          { name: 'coral', description: 'Coral', gender: 'female' },
          { name: 'echo', description: 'Echo', gender: 'female' },
          { name: 'fable', description: 'Fable - transatlantic', gender: 'female' },
          { name: 'onyx', description: 'Onyx', gender: 'male' },
          { name: 'nova', description: 'Nova', gender: 'female' },
          { name: 'sage', description: 'Sage', gender: 'female' },
          { name: 'shimmer', description: 'Shimmer', gender: 'female' },
          { name: 'verse', description: 'Verse', gender: 'female' },
        ],
      },
      // Gemini Live prebuilt voices — the canonical set exposed by Google's
      // Live API. The model handles any input language; the voice picks the
      // timbre.
      google: {
        any: [
          { name: 'Aoede', description: 'Aoede', gender: 'female' },
          { name: 'Charon', description: 'Charon', gender: 'male' },
          { name: 'Fenrir', description: 'Fenrir', gender: 'male' },
          { name: 'Kore', description: 'Kore', gender: 'female' },
          { name: 'Puck', description: 'Puck', gender: 'male' },
        ],
      },
      // Ultravox dynamic catalogue — keyed under the 'ultravox' vendor by
      // the upstream handler.
      ...ultravoxVoices,
    };
  })();

  /**
   * Outbound dispatch entry point — section 2.4 of the architecture doc.
   *
   * Reserves the agent concurrency slot (via call.start) before dispatching, so the
   * HTTP originator gets the busy/429 immediately. On dispatch failure the slot is
   * released by ending the call with an error reason.
   */
  static async outbound({ instance, callerId, calledId, metadata, aplisayId, srtp, registrationEndpointId, b2buaGatewayIp, b2buaGatewayTransport }) {
    const logger = defaultLogger;
    const { id: instanceId } = instance;

    logger.debug(
      { instanceId, callerId, calledId, metadata },
      'originating outbound Pipecat call',
    );

    let call;
    try {
      const callId = uuidv4();
      const sessionId = `outbound-${callId}-${Date.now()}`;

      call = await Call.create({
        id: callId,
        userId: instance.userId,
        organisationId: instance.organisationId,
        instanceId: instance.id,
        agentId: instance.agentId,
        platform: 'pipecat',
        platformCallId: sessionId,
        calledId,
        callerId,
        modelName: instance.Agent?.modelName,
        // Destination billing (D3): an originate on a PhoneNumber caller (aplisayId
        // set) egresses our public trunk → chargeable. A registration caller
        // (aplisayId null) egresses the customer B2BUA → not charged. Unset
        // APLISAY_OUTBOUND_TRUNK_ID → undefined (fail-safe).
        // Destination billing only on our public trunk: a registration trunk's
        // number egresses the customer's own B2BUA and is never charged.
        outboundTrunkId: aplisayId && !registrationEndpointId ? (process.env.APLISAY_OUTBOUND_TRUNK_ID || undefined) : undefined,
        options: { outbound: true },
        metadata: {
          ...(metadata || {}),
          aplisayId,
          outbound: true,
        },
      });

      try {
        await call.start({
          instance,
          user: instance.User,
          organisation: instance.Organisation,
        });
      } catch (e) {
        // call.start() updates call.status on concurrency failure; let it propagate.
        throw e;
      }

      const dispatchResult = await Pipecat.dispatchToWorker({
        kind: 'outbound',
        sessionId,
        callId,
        callerId,
        calledId,
        instanceId,
        aplisayId,
        callMetadata: metadata,
        ...(srtp === false ? { srtp: false } : {}),
        ...(registrationEndpointId && b2buaGatewayIp
          ? { registrationEndpointId, b2buaGatewayIp, b2buaGatewayTransport: b2buaGatewayTransport || 'tcp' }
          : {}),
      });

      logger.debug({ dispatchResult, sessionId }, 'Pipecat worker dispatched for outbound call');

      return {
        success: true,
        callId,
        sessionId,
        dispatchResult,
      };
    } catch (error) {
      logger.error(
        { error, instanceId, callerId, calledId },
        'Failed to originate outbound Pipecat call',
      );
      if (error instanceof AgentConcurrencyLimitExceededError) {
        throw error;
      }
      if (call) {
        await call.end(`Outbound call origination failed: ${error.message}`).catch(() => {});
      }
      throw new Error(`Outbound call origination failed: ${error.message}`);
    }
  }

  /**
   * Non-SIP credentialed join — section 2.5 of the architecture doc.
   *
   * Returns credentials wrapped in a `{ pipecat: ... }` namespace key per the
   * polymorphic listener-endpoint contract. The credentials let a browser client
   * negotiate a peer-to-peer WebRTC session directly with the Pipecat worker via
   * SmallWebRTCTransport.
   */
  async join() {
    const { logger, instance: { id: instanceId } } = this;
    logger.debug({ instanceId }, 'minting Pipecat join credentials');
    try {
      if (!PIPECAT_PUBLIC_URL) throw new Error('PIPECAT_PUBLIC_URL is not defined');
      if (!PIPECAT_JOIN_SECRET) throw new Error('PIPECAT_JOIN_SECRET is not defined');

      const sessionId = `join-${instanceId}-${Date.now()}`;
      // Short-lived (5 minute) join token authenticating the browser to the
      // worker's WebRTC offer endpoint.
      const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
      const payload = JSON.stringify({ instanceId, sessionId, expiresAt });
      const signature = crypto
        .createHmac('sha256', PIPECAT_JOIN_SECRET)
        .update(payload)
        .digest('base64url');
      const token = `${Buffer.from(payload).toString('base64url')}.${signature}`;

      // The signed token rides as a query param on the offer URL so the
      // browser client can use stock @pipecat-ai/small-webrtc-transport
      // without overriding its request body. The token is short-lived (5 min)
      // and HMAC-signed, so query-string transport is acceptable.
      const offerUrl = `${PIPECAT_PUBLIC_URL.replace(/\/$/, '')}/webrtc/offer?token=${encodeURIComponent(token)}`;

      const pipecat = {
        offerUrl,
        sessionId,
        token,
        instanceId,
        // ICE servers are returned by the worker on POST /webrtc/offer; clients
        // do not need them up front.
      };
      logger.debug({ pipecat }, 'pipecat join credentials minted');
      return { pipecat };
    } catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Call setup: ${error.message}`);
    }
  }

  /**
   * POST a dispatch request to the worker. The worker authenticates the request
   * via the shared bearer token from PIPECAT_DISPATCH_TOKEN.
   */
  static async dispatchToWorker(payload) {
    const url = `${PIPECAT_WORKER_URL.replace(/\/$/, '')}/dispatch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PIPECAT_DISPATCH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pipecat worker dispatch failed: ${res.status} ${body}`);
    }
    return res.json().catch(() => ({}));
  }

  async destroy() {
    const { logger, agent, instance } = this;
    logger.debug({ instanceId: instance?.id }, 'pipecat call ending');
    try {
      instance && (await instance.destroy({ logging: logger.debug }));
      agent && (await agent.destroy({ logging: logger.debug }));
    } catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Pipecat teardown: ${error.message}`);
    }
  }
}

export default Pipecat;
