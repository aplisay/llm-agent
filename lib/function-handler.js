import axios from 'axios';
import logger from './logger.js';
import { getByPath } from './metadata-path.js';
import { currentDateTimeString, isDateTimeMetadataKey } from './current-datetime.js';
import { InfrastructureError } from './errors.js';

const hardwiredBuiltins = {
  /**
   * Invoke a `text` type agent as a function call. The `agent` parameter
   * (static or metadata sourced) is the target agent UUID; all generated
   * parameters are forwarded as the subagent's task input. Resolution order:
   *  1. `options.invokeSubagent` — an in-process invoker injected by the caller
   *     (used server-side, and by workers that wire their own API client).
   *  2. REST fallback to the platform internal subagent API using
   *     SERVICE_BASE_URI / SHARED_API_TOKEN (out-of-process workers).
   */
  subagent: async (input, metadata, options = {}) => {
    const { agent, ...args } = input;
    if (!agent) {
      // The agent target is a static/metadata parameter, not model-controlled —
      // a missing one is a malformed function definition, not a bad model call.
      throw new InfrastructureError('subagent function call has no agent parameter');
    }
    if (options.invokeSubagent) {
      return await options.invokeSubagent(agent, args, metadata);
    }
    const base = process.env.SERVICE_BASE_URI;
    const token = process.env.SHARED_API_TOKEN;
    if (!base) {
      throw new InfrastructureError('subagent invocation unavailable: no invoker and no SERVICE_BASE_URI');
    }
    const { data } = await axios.post(`${base}/api/agent-db/subagent`,
      {
        agentId: agent,
        input: args,
        metadata,
        organisationId: options.subagentContext?.organisationId,
        callId: options.subagentContext?.callId
      },
      { headers: { ...(token && { 'x-shared-token': token }) } });
    return data?.result;
  },
  /**
   * Create an agent set from a document the LLM assembled. Only available when
   * the caller injects `options.createAgentSet` (the interactive set-builder
   * chat session does); the implementation there is scoped to the agent's org.
   */
  create_agent_set: async (input, metadata, options = {}) => {
    if (!options.createAgentSet) {
      throw new InfrastructureError('create_agent_set is not available in this context');
    }
    return await options.createAgentSet(input);
  },
  /** Update an existing agent set (full-state reconcile by label). Needs `options.updateAgentSet`. */
  update_agent_set: async (input, metadata, options = {}) => {
    if (!options.updateAgentSet) {
      throw new InfrastructureError('update_agent_set is not available in this context');
    }
    const { id, agentSetId, ...doc } = input;
    return await options.updateAgentSet(id || agentSetId, doc);
  },
  /**
   * Incrementally patch an agent set: upsert only the provided members (by
   * label), leave the rest untouched, delete `removeLabels`. Needs
   * `options.patchAgentSet`. Lets the builder edit one member without resending
   * the whole set (avoiding output-token truncation on large sets).
   */
  patch_agent_set: async (input, metadata, options = {}) => {
    if (!options.patchAgentSet) {
      throw new InfrastructureError('patch_agent_set is not available in this context');
    }
    const { id, agentSetId, ...doc } = input;
    return await options.patchAgentSet(id || agentSetId, doc);
  },
  metadata: (input, metadata, options = {}) => {
    let { keys } = input;
    if (typeof keys === 'string') {
      keys = keys.split(',').map(key => key.trim());
    }
    !Array.isArray(keys) && (keys = [keys]);
    let result = {};
    keys.forEach(key => {
      if (!options.allowToolsCallsMetadataPaths && (key === 'toolsCalls' || key.startsWith('toolsCalls.'))) {
        throw new InfrastructureError('Access to metadata.toolsCalls is only allowed in LiveKit agents');
      }
      // `aplisay.dateTime` is the live current date/time, computed here rather
      // than seeded — models have no clock, so this is their ground truth for
      // date reasoning (see current-datetime.js). A real value in the metadata
      // still wins (nothing seeds it today).
      if (isDateTimeMetadataKey(key) && (getByPath(metadata, key) === undefined || getByPath(metadata, key) === null)) {
        result[key] = currentDateTimeString();
        return;
      }
      const value = getByPath(metadata, key);
      result[key] = value === undefined || value === null ? 'unknown' : value;
    });
    logger.debug({ result, keys, metadata }, 'metadata result');
    return result;
  },
  /**
   * Read-only TTS voice catalogue lookup for the set builder. Three modes:
   * - `modelName` only → the available locales (+ `voiceStack`).
   * - `modelName` + `locale` → that locale's `vendor → voices[]` rows (each
   *   voice has name/gender/description), trimmed to keep the payload bounded.
   * - `modelName` + `search` → the UNION of voices across the whole catalogue
   *   whose name/description/gender/locale matches ANY search term, with NO cap,
   *   so the model can find a voice by accent/gender/persona (see
   *   searchModelVoices). `search` takes precedence over `locale`.
   * Backed by the same lib/model-voices.js helpers as GET
   * /models/:modelName/voices[/:locale], so the builder sees exactly what agent
   * validation will accept. Lazy-imported so this module stays loadable in
   * contexts without the voice/handler graph (it only runs in the API process,
   * where the interactive set-builder chat session lives).
   */
  list_voices: async (input) => {
    const { modelName, locale, search } = input || {};
    if (!modelName) throw new Error('list_voices requires a modelName (e.g. "livekit:ultravox/ultravox-v0.7")');
    const [{ getModelVoiceLocales, getModelVoicesForLocale, searchModelVoices }, { default: Voices }] = await Promise.all([
      import('./model-voices.js'),
      import('./voices/index.js'),
    ]);
    const voicesInstance = new Voices();
    // `search` mode: ranked word-start union match across the whole catalogue
    // (best matches first, per-term hit counts, explicit unmatched terms), so
    // a named/accented/gendered voice is reachable even when it sorts past
    // the trimmed browse list (trimVoicesResult). Presentation is bounded by
    // trimSearchVoicesResult — ranked, so the cap sheds only the weakest tail.
    const hasSearch = Array.isArray(search)
      ? search.some((t) => String(t ?? '').trim())
      : (typeof search === 'string' && search.trim().length > 0);
    if (hasSearch) {
      return trimSearchVoicesResult(await searchModelVoices({ modelName, terms: search, voicesInstance }));
    }
    const result = locale
      ? await getModelVoicesForLocale({ modelName, locale, voicesInstance })
      : await getModelVoiceLocales({ modelName, voicesInstance });
    return trimVoicesResult(result);
  }
};

// Bound the list_voices *browse* payload for the LLM: the raw catalogue for a
// big vendor set (ultravox realtime: ~25KB / ~6k tokens) rides the conversation
// for the rest of the session once fetched. Voice choice needs name, gender
// and a short description — cap the description and the per-vendor list, with
// an explicit trailing note so the model knows more exist and can `search` the
// full catalogue or ask the user rather than assume the list is complete. Only
// the untargeted per-locale browse is trimmed: `search` mode returns every
// match uncapped, and the REST endpoint (GET /models/:modelName/voices) is
// untouched.
const VOICES_PER_VENDOR = 60;
const VOICE_DESCRIPTION_CHARS = 100;
// Exported for tests only — not part of the module's public surface.
export function trimVoicesResult(result) {
  if (!result || !result.vendors || typeof result.vendors !== 'object') return result;
  const vendors = {};
  for (const [vendor, voices] of Object.entries(result.vendors)) {
    if (!Array.isArray(voices)) {
      vendors[vendor] = voices;
      continue;
    }
    const kept = voices.slice(0, VOICES_PER_VENDOR).map((v) => (
      v && typeof v.description === 'string' && v.description.length > VOICE_DESCRIPTION_CHARS
        ? { ...v, description: `${v.description.slice(0, VOICE_DESCRIPTION_CHARS)}…` }
        : v
    ));
    vendors[vendor] = voices.length > kept.length
      ? [...kept, {
        note: `…and ${voices.length - kept.length} more ${vendor} voices not shown. To find a specific voice, `
          + 'call list_voices again with `search` terms (accent, gender, language or persona — e.g. '
          + '["british","robotic"]); it returns every match across the FULL catalogue ranked best-first. If the '
          + 'user names a specific voice, use that name verbatim — creation validates against the full '
          + 'catalogue, not this trimmed list.',
      }]
      : kept;
  }
  return { ...result, vendors };
}

// Bound the list_voices *search* payload the same way. Search results are
// RANKED (most distinct terms matched first), so the cap sheds only the
// weakest single-term tail — a named-voice lookup or a multi-term match is
// never the row that gets cut. When a term matched nothing, say so in-band:
// an absent accent must read as "not in this catalogue", never as a broken
// tool (a builder model once diagnosed exactly that from an unranked wall of
// near-miss matches and refused to build).
const SEARCH_MATCHES_PER_VENDOR = 60;
// Exported for tests only — not part of the module's public surface.
export function trimSearchVoicesResult(result) {
  if (!result || !result.vendors || typeof result.vendors !== 'object') return result;
  const vendors = {};
  for (const [vendor, voices] of Object.entries(result.vendors)) {
    if (!Array.isArray(voices)) {
      vendors[vendor] = voices;
      continue;
    }
    const kept = voices.slice(0, SEARCH_MATCHES_PER_VENDOR).map((v) => (
      v && typeof v.description === 'string' && v.description.length > VOICE_DESCRIPTION_CHARS
        ? { ...v, description: `${v.description.slice(0, VOICE_DESCRIPTION_CHARS)}…` }
        : v
    ));
    vendors[vendor] = voices.length > kept.length
      ? [...kept, {
        note: `…and ${voices.length - kept.length} weaker ${vendor} matches not shown (results are ranked `
          + 'best-first). Add more specific terms to narrow the search.',
      }]
      : kept;
  }
  const out = { ...result, vendors };
  if (Array.isArray(result.unmatchedTerms) && result.unmatchedTerms.length) {
    out.note = `No voice matched: ${result.unmatchedTerms.join(', ')}. That quality is not in this model's `
      + 'catalogue — this is a real answer, not a tool failure. Offer the user the closest real voices from '
      + 'the matches (see each matchedTerms), or a different model/stack that has such a voice.';
  }
  return out;
}

async function functionHandler(function_calls, functions, keys, messageHandler, metadata, specficBuiltins, options = {}) {
  let builtins = { ...hardwiredBuiltins, ...specficBuiltins };
  const tryParseJson = (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const writeToolResultToMetadata = (toolName, parameter, result, error) => {
    if (!metadata || typeof metadata !== 'object') return;
    metadata.toolsCalls = metadata.toolsCalls || {};
    metadata.toolsCalls[toolName] = metadata.toolsCalls[toolName] || {};
    metadata.toolsCalls[toolName].parameter = parameter;
    if (error) metadata.toolsCalls[toolName].error = error;
    const parsed = tryParseJson(result);
    metadata.toolsCalls[toolName].result = parsed !== undefined ? parsed : result;
  };
  const replaceParameters = (str, input) => {
    let result = str;
    let left = {};
    logger.debug({ str, input }, 'calling replaceParameters onentry');
    Object.keys(input).forEach(key => {
      logger.debug({ key, includes: result.includes(`{${key}}`), str }, 'key');
      if (result.includes(`{${key}}`)) {
        result = result.replace(`{${key}}`, `${input[key]}`);
      }
      else {
        left[key] = input[key];
      }
    });
    logger.debug({ result, left, str, input }, 'replaceParameters done ');
    return { result, left };
  };

  if (function_calls) {
    // Execute sequentially so later tool calls can read results written to metadata
    let function_results = [];
    for (const fn of function_calls) {
      const f = functions.find(entry => entry.name === fn.name);
      const canRedactFunctionResult = !!(options.allowRedactedFunctionResults && f?.redact);
      let result, error;
      logger.debug({ f }, 'got base function');
      const input = Object.fromEntries(Object.entries(f.input_schema.properties).map(([key, entry]) => {
        let value;
        if (entry.source === 'static' && entry.from) {
          value = entry.from;
          // Coerce a string literal to the declared parameter type. Static `from` values may be
          // supplied as strings by config templating, but downstream consumers may check them
          // strictly (e.g. the transfer handler's `consultFeedback === true`), so a string "true"
          // would otherwise be silently treated as false.
          if (entry.type === 'boolean' && typeof value === 'string') {
            value = /^true$/i.test(value.trim());
          } else if (entry.type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
            value = Number(value);
          }
        }
        else if (entry.source === 'metadata') {
          if (!options.allowToolsCallsMetadataPaths && (entry.from === 'toolsCalls' || entry.from?.startsWith('toolsCalls.'))) {
            throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
          }
          value = getByPath(metadata, entry.from);
          if (value === undefined || value === null) {
            throw new Error(`Metadata ${entry.from} not found`);
          }
        }
        value = value ?? fn.input?.[key] ?? entry.default;
        return [key, value];
      }));
      logger.debug({ f, input }, 'got base function with inputs');

      if (f && f.implementation === 'stub') {
        logger.debug({
          function_calls: [{
            name: f.name,
            arguments: input
          }]
        }, 'sending stub function');
        messageHandler && messageHandler({
          function_calls: [{
            name: f.name,
            arguments: input
          }]
        });
        ({ result } = replaceParameters(f.result, input));
      }
      else if (f && f.implementation === 'rest') {
        let key = f.key && keys.find(entry => entry.name === f.key);
        let authHeader = key?.in && {
          basic: {
            Authorization: `Basic ${key.value}`
          },
          bearer: {
            Authorization: `Bearer ${key.value}`
          },
          header: {
            [key.header || 'noused']: `${key.value}`
          },
        }[key.in];
        // The authHeader shape (header name + scheme) with the secret portion
        // masked — the form the callout takes everywhere outside the request
        // itself (logs and telemetry).
        let displayHeader = key?.in && {
          basic: { Authorization: 'Basic ***' },
          bearer: { Authorization: 'Bearer ***' },
          header: { [key.header || 'noused']: '***' },
        }[key.in];

        logger.debug({ displayHeader, keyName: f.key }, 'authHeader');

        try {
          logger.debug({ input }, 'input after defaulting');
          let { result: replaced, left } = replaceParameters(f.url, input);
          let url, data;
          const method = f.method?.toUpperCase();
          if (method.includes('POST') || method === 'PUT') {
            url = new URL(replaced);
            data = left;
          }
          else {
            let params = new URLSearchParams(left);
            url = new URL(replaced + (params.toString() ? `?${params.toString()}` : ''));
          }
          logger.debug({ url, data }, 'url after construction');

          messageHandler && messageHandler({
            rest_callout: {
              url: url.toString(),
              method: f.method?.toUpperCase(),
              body: f.method === 'post' ? input : '',
              headers: displayHeader
            },
          });
          let response = await axios(
            {
              url,
              method: f?.method || 'get',
              data,
              headers: authHeader,
            }
          );
          result = JSON.stringify(response.data, null, 2);
        }
        catch (e) {
          if (e.response && e.response.data) {
            result = typeof e.response.data === 'object' ? ({ ...e.response.data }) : e.response.data;
          }
          else {
            result = e.message;
          }
          error = { status: e.response?.status, statusText: e.response?.statusText, message: e?.message };
          logger.info({ error }, 'error in function handler');
          result = JSON.stringify(result, null, 2);
        }
      }
      else if (f && f.implementation === 'builtin' && builtins[f.platform]) {
        try {
          result = JSON.stringify(await builtins[f.platform](input, metadata, options));
        } catch (e) {
          // Infrastructure / context failures (missing service config, a builtin
          // not wired into this runtime, a disallowed access path) are not
          // something the model can fix by retrying — let them propagate and
          // abort the turn so the misconfiguration surfaces.
          if (e instanceof InfrastructureError) throw e;
          // Everything else is model-fixable: return the failure to the model as
          // the tool result (mirroring the `rest` branch) so it can read the
          // message, look up the correct shape on the MCP, fix the call and retry
          // — instead of the error propagating up and aborting the whole turn.
          error = { message: e.message };
          result = JSON.stringify({ error: e.message });
          logger.info({ platform: f.platform, error: e.message }, 'builtin function failed; returning error to model');
        }
      }

      const rawResult = result;
      const llmResult = canRedactFunctionResult
        ? (error ? 'FAILED - invocation failed' : 'OK - function completed')
        : rawResult;

      const toolResult = error ? { ...fn, result: llmResult, error } : { ...fn, result: llmResult };
      writeToolResultToMetadata(fn.name, input, rawResult, error);
      function_results.push(toolResult);
    }
    messageHandler({ function_results: function_results.map(f => ({ name: f.name, input: f.input, result: f.result })) });
    logger.debug({ function_calls, functions, function_results }, 'function_results');
    return { function_results };
  }
};

export {
  functionHandler,
};

