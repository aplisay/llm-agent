import axios from 'axios';
import Handler from './handler.js';
import JambonzHandler from './jambonz.js';
import UltravoxModel from '../models/ultravox.js';
import { Call } from '../database.js';
import { maybeSendCallHook } from '../call-hook.js';
import { AgentConcurrencyLimitExceededError } from '../concurrency/agent-concurrency-limits.js';
import { promptWithMetadata } from '../prompt-metadata.js';
const { ULTRAVOX_API_KEY, JAMBONZ_AGENT_NAME } = process.env;
import { v4 as uuidv4 } from 'uuid';

const api = axios.create({
  baseURL: 'https://api.ultravox.ai/api/',
  headers: {
    'X-API-Key': process.env.ULTRAVOX_API_KEY
  }
});

const getVoices = (async () => {
  let next = '/voices'
  let voices = [];
  while (next) {
    let { data: { next: nextUrl, results } } = await api.get(next);
    next = nextUrl;
    voices = [...voices, ...results.map(({ name, description }) => (
      {
        name,
        description: name.length < 20 ? `${name} - ${description}` : (description || name),
        gender: 'unknown',
      }
    ))]
  }
  return {
    ultravox: {
      'any': voices
    }
  };
})()

class Ultravox extends Handler {
  static name = 'ultravox';
  static description = 'Ultravox';
  // Native WebRTC (direct browser ↔ Ultravox) runs on our ULTRAVOX_API_KEY alone,
  // so it is available whenever this handler loads. Telephony (inbound SIP),
  // however, is delegated to jambonz — see `telephonyHandler` and the
  // ultravox→jambonz number-pool mapping in Handler.activate(). So Ultravox is
  // only telephony-capable when jambonz itself is in the bundle
  // (JAMBONZ_API_KEY + JAMBONZ_SERVER set). Consumed per-model in GET /models and
  // by the rate-components audio-path catalogue.
  static get hasTelephony() {
    return JambonzHandler.canLoad.ok;
  }
  static hasWebRTC = true;
  static hasWebSocket = true;
  static telephonyHandler = 'jambonz';


  static get models() {
    return [
      UltravoxModel
    ];
  }
  static needKey = { ULTRAVOX_API_KEY };
  static voices = getVoices;


  async join({ websocket, telephony = false, options = {}, callerId = 'WebRTC', calledId = 'WebRTC', callId = this.callId }) {
    let { agent: { id: agentId, userId, organisationId, modelName, promptMetadata, options: agentOptions = {} }, logger, instance: { id: instanceId, metadata: instanceMetadata } } = this;
    let { fallback: { number: fallbackNumbers } = {} } = agentOptions;
    if (!callId) {
      callId = uuidv4();
      logger.info({ callId, thisCallId: this.callId }, 'no callId provided, generating one');
    }
    const metadata = {
      ...instanceMetadata,
      ...options.metadata,
      aplisay: {
        callId,
        callerId,
        calledId,
        fallbackNumbers,
        modelName
      }
    };

   

    this.model.metadata = metadata;
    // State the agent's declared `promptMetadata` facts (today's date, the
    // caller's number, …) in its system prompt now that call metadata exists —
    // the prompt setter propagates into the messages array too. Composed from
    // initialPrompt so a re-join can never stack blocks. See lib/prompt-metadata.js.
    this.model.prompt = promptWithMetadata(this.model.initialPrompt, promptMetadata, metadata);
    this.model.functions = this.model._functions || [];
    let { model: { modelData } } = this;

    websocket = websocket || this.instance.websocket;


    try {
      logger.debug({ self: this, modelData, metadata, websocket, callId }, 'Starting inband call');
      // firstSpeaker defaults to the agent speaking first (right for the embedded widget, where the
      // agent greets the human). A websocket *caller* (e.g. an automated test caller dialling into
      // another agent over WebRTC) should instead wait for the callee to greet: set the agent
      // option `firstSpeaker: 'user'`.
      const firstSpeakerOption = String(agentOptions?.firstSpeaker ?? '').toLowerCase();
      const firstSpeaker =
        firstSpeakerOption === 'user' || firstSpeakerOption === 'first_speaker_user'
          ? 'FIRST_SPEAKER_USER'
          : 'FIRST_SPEAKER_AGENT';
      websocket && Object.assign(modelData, {
        medium: {
          serverWebSocket: {
            inputSampleRate: telephony ? 8000 : 48000,
            outputSampleRate: telephony ? 8000 : 48000,
            clientBufferSizeMs: 60
          }
        },
        // Ultravox rejects a request carrying both the legacy `firstSpeaker` enum and
        // `firstSpeakerSettings` (set by the model driver for `options.greeting` or
        // vendorSpecific pass-through), so only send the enum when no settings exist.
        ...(modelData.firstSpeakerSettings ? {} : { firstSpeaker }),
        recordingEnabled: true
      });
      let {
        data: { callId: platformCallId, ended, joinUrl }
      } = await api.post('calls', modelData);
      if (ended || !platformCallId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      logger.info({
        agentId, instanceId, callId,userId, callerId,
        callId,
        calledId, organisationId, platformCallId, platform: 'ultravox'
      }, 'creating placeholder call record');
      if (!telephony) {
        // In some contexts (e.g. telephone calls) the caller is responsible for creating the call record
        const callRecord = await Call.create({
          id: callId,
          agentId,
          instanceId,
          userId,
          organisationId,
          modelName,
          options: agentOptions,
          callerId,
          calledId,
          platformCallId,
          platform: 'ultravox',
          metadata
        });

        await callRecord.start({
          instance: this.instance,
          user: this.instance?.User,
          organisation: this.instance?.Organisation,
        });

        // Fire callHook start callback for Ultravox WebRTC calls (non-blocking)
        maybeSendCallHook({
          event: 'start',
          call: callRecord,
          agent: this.agent,
          listenerOrInstance: this.instance,
          logger
        }).catch((err) => {
          logger?.warn?.(err, 'error sending Ultravox callHook start callback');
        });
      }
      
      joinUrl = new URL(joinUrl);
      websocket && joinUrl.searchParams.append('experimentalMessages', 'debug');
      callId && (this.callId = callId);
      logger.debug({ joinUrl }, 'In band call started');
      return {
        ultravox: { joinUrl: joinUrl.toString() },
        audioSocket: {
          url: joinUrl.toString()
        },
        callId
      };
    }
    catch (error) {
      // Preserve concurrency limit errors so the HTTP layer can return HTTP 429.
      if (error instanceof AgentConcurrencyLimitExceededError) {
        throw error;
      }
      const response = error?.response;
      const responseBody = response?.data;

      // Log as much detail as we can about the far-end error
      logger.error({
        error,
        status: response?.status,
        statusText: response?.statusText,
        responseBody
      }, error.message);

      let bodyMessage;
      if (responseBody) {
        if (typeof responseBody === 'string') {
          bodyMessage = responseBody;
        }
        else if (typeof responseBody === 'object') {
          bodyMessage =
            responseBody.message ||
            responseBody.error ||
            responseBody.detail ||
            JSON.stringify(responseBody);
        }
      }

      const extraParts = [];
      if (response?.status) {
        extraParts.push(`status ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      }
      if (bodyMessage) {
        extraParts.push(`body: ${bodyMessage}`);
      }

      const extraText = extraParts.length ? ` (${extraParts.join(' | ')})` : '';

      throw new Error(`Call setup: ${error.message}${extraText}`);
    }
  }

  async preWarmup() {
    let { logger } = this;
    try {
      logger.debug('Prewarming jambonz handler');
      await axios.get(`https://${JAMBONZ_AGENT_NAME}/ping`);
      logger.debug('Prewarming jambonz handler done');
    }
    catch (error) {
      logger.debug({ message: error?.message }, 'handler prewarm error (expected)');
    }
  }

  // TODO: implement
  async warmup() {
    // TODO: implement
  }

  // TODO: implement
  async shutdown() {
    // TODO: implement
  }

  // TODO: implement

  async destroy() {

    let { callId, logger } = this;
    logger.debug({ callId }, 'Inband call ending');

    try {
      if (!callId) {
        await api.delete(`calls/${callId}`);
      }
    }
    catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Inband call teardown: ${error.message}`);
    }

  }

  async handleMessage(message, post) {
    let { callId, logger } = this;
    let { type } = message;
    switch (type) {
      case 'transcript':
        let { role, text, delta, final: isFinal } = message;
        await post({ callId, type: role, data: text || delta }, isFinal, !!delta);
        break;
      case 'debug':
        let debug = message && message.type && message.message;
        try {
          if (debug && debug.startsWith('LLM response: \nTool calls:')) {
            let res = [...debug.matchAll(/FunctionCall\(name='([^']*)'.*args='([^']*)'.*\)/ig) || []];
            let [[, method, body]] = res;
            logger.debug({ method, body, res, debug: JSON.stringify(debug) }, 'tool call debug');
            method && body && post({ type: 'rest_callout', data: { method, body, url: "" } });
          }
          else if (debug && debug.startsWith('Tool call complete. Result: ')) {
            let res = [...(debug.matchAll(/.*role: MESSAGE_ROLE_TOOL_RESULT[\s\S]*text: "(.*)"[\s\S]*tool_name: "(.*)"/ig) || [])];
            let [[, body, name]] = res;
            logger.debug({ res, body, name, debug: JSON.stringify(debug) }, 'tool result debug');
            body && post({ type: 'function_results', data: [{ name, input: [], result: body.replace(/\\/g, '') }] });
          }
        }
        catch (error) {
          logger.error({ error }, `parse error ${error.message}`);
        }
        break;
      default:
        break;
    }
  }

  static ROLE_MAP = {
    'MESSAGE_ROLE_USER': 'user',
    'MESSAGE_ROLE_AGENT': 'agent',
    'MESSAGE_ROLE_TOOL_CALL': 'rest_callout',
    'MESSAGE_ROLE_TOOL_RESULT': 'function_results',
    'MESSAGE_ROLE_UNSPECIFIED': 'error'
  };

  async callEnded(ultravoxCall, call) {
    let { logger } = this;
    let { callId, created: startedAt, ended: endedAt } = ultravoxCall;
    try {
      // Idempotent: in production this webhook is just one of several end paths and
      // the call has usually already been ended (e.g. via the worker or the
      // agent-db end endpoint). A not-live call is already finalised — bail rather
      // than re-finalise or re-run the (non-idempotent) transcript backfill below.
      if (!call.live) {
        logger.debug({ callId: call.id }, 'ultravox callEnded: call already ended, skipping');
        return;
      }
      // Adopt Ultravox's authoritative call timing, then finalise through the one
      // canonical end path — Call.end() marks the call not-live, releases the agent
      // concurrency reservation taken at Call.start(), and writes the voice-minute
      // usage row. (Previously this path saved timing + usage but left the call
      // 'in progress' with its concurrency slot held — a leak in production.)
      if (startedAt) call.startedAt = new Date(startedAt);
      await call.end('ultravox call ended', { endedAt: endedAt ? new Date(endedAt) : undefined });
      if (callId) {
        this.callId = call.id;
        let apiCall = `calls/${callId}/messages`;
        do {
          let { data: { next, results } } = await api.get(apiCall);
          logger.debug({ next, results, callId }, 'got messages');
          apiCall = next;
          for (var message of results){
            message.role = Ultravox.ROLE_MAP[message.role];
            if (message.role === 'function_results') {
              message.text = JSON.stringify([{ name: message.toolName, input: {}, result: message.text }]);
            }
            if (message.role === 'rest_callout') {
              message.text = JSON.stringify({method: '', url: message.toolName, body: message.text});
            }
            message.role && await this.handleMessage({ ...message, type: 'transcript' }, this.transcript.bind(this));
          };
        }
        while (apiCall);
        logger.debug({ call }, 'callEnded');
      }
    }
    catch (error) {
      logger.error({ error }, `callEnded error ${error.message}`);
    }
  }
}

export default Ultravox;