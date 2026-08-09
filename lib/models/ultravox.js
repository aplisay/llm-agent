import axios from 'axios';
import Llm from './llm.js';
import { getByPath } from '../metadata-path.js';
const { ULTRAVOX_API_KEY } = process.env;


const api = axios.create({
  baseURL: 'https://api.ultravox.ai/api/',
  headers: {
    'X-API-Key': process.env.ULTRAVOX_API_KEY
  }
});

const LOCATION = {
  path: 'PARAMETER_LOCATION_PATH',
  query: 'PARAMETER_LOCATION_QUERY',
  body: 'PARAMETER_LOCATION_BODY',
  default: 'PARAMETER_LOCATION_UNSPECIFIED'
};


/**
 * Implements the LLM class against the Ultravox model
 * The ultravox model is a bit special in that we don't (currently) do an inband processing
 * of agent interactions. Instead, we just setup the model, fire and forget and ultravox infra
 * handles all interactions with the LLM. This is unsustainable as it cuts us out of the transaction
 * logging loop. Suspect this will change as their interface develops.
 *
 * 
 * @param {Object} logger Pino logger instance
 * @param {string} user a unique user ID
 * @param {string} prompt The initial (system) chat prompt
 * @param {Object} options options
 * @param {number} options.temperature The LLM temperature
 *                 See model documentation
 * @class Ultravox
 * @extends {Llm}
 */
class Ultravox extends Llm {

  // Because; reasons
  static name = 'ultravox';
  static aliases = ['fixie-ai'];

  static allModels = [
    ["fixie-ai/ultravox-8B", "Ultravox 8B", "ultravox/ultravox-v0.6"],
    ["fixie-ai/ultravox-70B", "Ultravox 70B", "ultravox/ultravox-v0.6"],
     ["ultravox/ultravox-v0.6", "Ultravox 0.6"],
     ["ultravox/ultravox-v0.6-gemma3-27b", "Ultravox 0.6 Gemma3"],
     ["ultravox/ultravox-v0.6-llama3.3-70b", "Ultravox 0.6 Llama3.3 70B"],
     ["ultravox/ultravox-v0.7", "Ultravox 0.7 (GLM 4.6)"]
  ];

  static get needKey() {
    return { ULTRAVOX_API_KEY };
  }

  static get voices() {
    return api.get('/voices').then(res => (
      {
        ultravox: {
          'en-US': res.data.results.map(({ name, description }) => (
            {
              name,
              description: name.length < 20 ? `${name} - ${description}` : description,
              gender: 'unknown',
            }
          ))
        }
      }
    ));
  }

  /**
   * Ultravox supports function calling on everything except 8B models    *
   * @static 
   * @memberof OpenAi
   */
  static supportsFunctions = (model) => !model.match(/-8B$/i);

  // Ultravox is an audio model so no STT and TTS is builtin etc
  static audioModel = true;

  /**
   * Creates an instance of Ultravox.
   * @memberof OpenAi
   */
  constructor(args) {
    super(args);
    let { modelName, metadata } = args;
    this.metadata = metadata;
    let [, model] = modelName.split(':');
    this.api = api;
    // Handle aliases
    this.model = Ultravox.allModels.find(m => m[0].toLowerCase() === model.toLowerCase())?.[2] || model || Ultravox.allModels[0][0];
    this.logger.debug({ model: this.model, modelName, allModels: Ultravox.allModels, found: Ultravox.allModels.find(m => m[0].toLowerCase() === model.toLowerCase()) }, 'NEW Ultravox agent');
    this.logger.debug({ args }, 'NEW Ultravox agent');
  }

  // Ultravox is special in that the provider `fixie-ai/`... *is* passed
  // to the api, so override the superclass which strips this
  set model(newModel) {
    this.gpt = { ...(this.gpt || {}), model: newModel };
  }


  set prompt(newPrompt) {
    this?.logger?.debug({ newPrompt }, 'Setting prompt');
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }

  getAuth(keyName) {
    let { logger } = this;
    let key = this?.keys?.find(k => k.name === keyName);
    let { in: type, header, name, value } = key || {};
    let requirements;
    switch (type) {
      case 'query':
        requirements = {
          [name]: {
            queryApiKey: {
              name
            }
          }
        };
        break;
      case 'header':
        requirements = {
          [name]: {
            headerApiKey: {
              name: header
            }
          }
        };
        break;
      case 'basic':
      case 'bearer':
        requirements = {
          [name]: {
            httpAuth: {
              scheme: type.charAt(0).toUpperCase() + type.slice(1)

            }
          }
        };
        break;
      default:
        requirements = undefined;
        break;
    };
    logger.debug({ keyName, key, keys: this.keys, type, header, name, value, requirements }, 'Setting ultravox auth');
    return requirements
      ? {
        authTokens: {
          [name]: value
        },
        requirements: {
          httpSecurityOptions: {
            options: [
              {
                requirements
              }
            ]
          }
        }
      }
      : {};

  }



  set functions(functions) {
    let { metadata } = this;
    this.logger.debug({ functions, metadata }, 'Setting functions here');
    this.tools = functions && functions
      .filter(({ implementation }) => implementation === 'client' || implementation === 'rest')
      .map(({ name, key, description, implementation, url, method, input_schema: { properties } }) => {
        let pUrl = URL.parse(url);
        let staticParameters = [];
        if (implementation === 'rest' && pUrl) {
          this.logger.debug({ req: {}, url, href: pUrl.href, pUrl, searchParams: pUrl.searchParams }, `doing function ${name}`);
          // Ultravox rejects any keys in the search params so we need to build static keys from any we find
          [...pUrl.searchParams?.entries?.()].forEach(([key, value]) => {
            if (!(value.match(/^\{(.*)\}$/) && properties[key])) {
              staticParameters.push({ name: key, value, location: LOCATION.query });
            }
            this.logger.debug({ req: {}, key, value }, `deleting ${key}`);
            pUrl.searchParams.delete(key);
          });
          
          this.logger.debug({ req: {}, url, href: pUrl.href, pUrl, saerchParams: pUrl.searchParams }, `function ${name}`);
        }
        let { requirements, authTokens } = this.getAuth(key);
        return {
          nameOverride: name,
          temporaryTool: {
            description,
            timeout: '8s',
            http: implementation === 'rest' ? {
              baseUrlPattern: pUrl?.href?.replace(/%7B([^%]*)%7D/g, '{$1}'),
              httpMethod: method?.toUpperCase()
            } :
              undefined,
            client: implementation === 'client' ? {} : undefined,
            dynamicParameters: (properties && Object.keys(properties).length > 0 &&
              Object.entries(properties)
              .filter(([name, { source }]) => source !== 'static' && source !== 'metadata')
              .map(([name, { description, type, required, in: location }]) => ({
                name,
                location: implementation === 'client' ? LOCATION['body'] : (LOCATION[location] || LOCATION.default),
                schema: {
                  type,
                  description
                },
                required: required || location === 'path'
              }))) || undefined,
            staticParameters: [...staticParameters, 
              ...Object.entries(properties)
                .filter(([, { source }]) => source === 'static' || source === 'metadata')
                .map(([name, { description, source, from, type, required, in: location }]) => {
                  let value =
                    source === 'metadata'
                      ? (getByPath(metadata, from) ?? '')
                      : from || '';
                  return {
                    name,
                    location: (LOCATION[location] || LOCATION.default),
                    value
                  };

                }
                ) 
            ],
            requirements
          },
          authTokens
        };
      });
    this?.logger?.debug({ functions, tools: this.tools }, 'Setting functions');
    this._functions = functions;
  }

  set keys(newKeys) {
    this.logger.debug({ newKeys }, 'Setting keys');
    this._keys = newKeys;
    this.functions = this._functions;
  }

  get keys() {
    return this._keys;
  }

  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = { voice: newOptions?.tts?.voice, ...newOptions };
  }
  get options() {
    return this._options;
  }

  /**
   * Parse `options.inactivity.timeout` into seconds: a number of seconds or a
   * duration string like `"8s"` — the same convention as the LiveKit worker's
   * `inactivityAwayTimeoutSecs`. Returns undefined when the block is absent or
   * malformed (no usable timeout, or no non-empty message), in which case no
   * inactivityMessages are sent and behaviour is unchanged.
   *
   * @static
   * @memberof Ultravox
   */
  /**
   * How many times the inactivity prompt is spoken before the call is considered
   * abandoned. Must stay in step with the LiveKit worker's
   * `INACTIVITY_PROMPT_COUNT` and the Pipecat worker's, so all three stacks agree
   * on what `options.inactivity.hangup` means.
   *
   * @static
   * @memberof Ultravox
   */
  static INACTIVITY_PROMPT_COUNT = 3;

  /**
   * UI / legacy values that mean "no fixed language" rather than a real tag.
   * Keep in sync with `NON_SPECIFIC_STT_LANGUAGES` in
   * agents/livekit/lib/pipeline-inference-options.ts.
   *
   * @static
   * @memberof Ultravox
   */
  static NON_SPECIFIC_LANGUAGES = new Set(['any', 'multi', '*', 'auto', 'all', 'global']);

  /**
   * The agent's declared language as a full BCP-47 tag (e.g. `en-GB`) for Ultravox's
   * `languageHint`, or undefined when unset or a "no fixed language" sentinel — in
   * which case the field is omitted and Ultravox auto-detects as before. `tts.language`
   * wins over `stt.language`, matching the LiveKit worker's `agentLanguageTag`.
   *
   * @static
   * @memberof Ultravox
   */
  static languageTag(options) {
    let raw = options?.tts?.language?.trim() || options?.stt?.language?.trim() || '';
    if (!raw || Ultravox.NON_SPECIFIC_LANGUAGES.has(raw.toLowerCase())) return undefined;
    return raw;
  }

  static inactivityTimeoutSecs(inactivity) {
    if (!inactivity || typeof inactivity !== 'object') return undefined;
    let { timeout, message } = inactivity;
    if (typeof message !== 'string' || !message.trim()) return undefined;
    let secs;
    if (typeof timeout === 'number' && isFinite(timeout)) {
      secs = timeout;
    }
    else if (typeof timeout === 'string') {
      let m = timeout.trim().match(/^(\d+(?:\.\d+)?)s?$/);
      m && (secs = parseFloat(m[1]));
    }
    return secs > 0 ? secs : undefined;
  }

  /**
   * Get the model data for the LLM. This model instantiation data in a form which can be used
   * to instantiate an agent in thier `call` rest endpoint.
   *
   * @readonly
   * @memberof Ultravox
   */
  get modelData() {
    let { _prompt: systemPrompt, _options, logger, tools, gpt: { model }} = this;
    let { temperature, voice, maxDuration, timeExceededMessage, greeting, inactivity, firstSpeaker, vendorSpecific } = _options || {};
    let data = {
      model: model.replace(/^.*\//, ''),
      maxDuration: maxDuration || '305s',
      timeExceededMessage: timeExceededMessage || 'It has been great chatting with you, but we have exceeded our time now.',
      systemPrompt,
      selectedTools: tools,
      temperature,
      voice,
      transcriptOptional: false,
    };

    // Provider-native pass-through: same whitelist as the LiveKit Ultravox plugin.
    let uv = vendorSpecific?.ultravox || {};
    uv.experimentalSettings && (data.experimentalSettings = uv.experimentalSettings);
    uv.vadSettings && (data.vadSettings = uv.vadSettings);
    // Portable `options.tts.language` (falling back to `options.stt.language`) →
    // provider-native `languageHint`, a BCP-47 tag guiding Ultravox's own ASR and
    // TTS. Ultravox is speech-to-speech, so there is no separate TTS to carry the
    // language — this is the only route the hint has. A native value wins; when
    // neither is present the field is omitted and Ultravox auto-detects.
    let languageHint =
      (typeof uv.languageHint === 'string' && uv.languageHint.trim()) ||
      Ultravox.languageTag(_options);
    languageHint && (data.languageHint = languageHint);
    Array.isArray(uv.inactivityMessages) && uv.inactivityMessages.length && (data.inactivityMessages = uv.inactivityMessages);
    uv.firstSpeakerSettings && (data.firstSpeakerSettings = uv.firstSpeakerSettings);

    // Portable `options.greeting` → firstSpeakerSettings, mirroring the LiveKit
    // session factory: exactly one of text|instructions, always uninterruptible.
    // Caller-supplied native firstSpeakerSettings win, as does an explicit
    // `firstSpeaker: 'user'` (websocket callers dialling into another agent).
    let greetingText = greeting?.text?.trim() || '';
    let greetingInstructions = greeting?.instructions?.trim() || '';
    let userFirst = ['user', 'first_speaker_user'].includes(String(firstSpeaker ?? '').toLowerCase());
    if (!data.firstSpeakerSettings && !userFirst && (!!greetingText !== !!greetingInstructions)) {
      data.firstSpeakerSettings = {
        agent: greetingText
          ? { uninterruptible: true, text: greetingText }
          : { uninterruptible: true, prompt: greetingInstructions }
      };
    }

    // Portable `options.inactivity` → provider-native inactivityMessages.
    // Ultravox fires each entry once, in sequence, after `duration` of further
    // user inactivity — a short run of identical entries gives the "re-fire on
    // each further timeout of continued silence" behaviour (up to
    // INACTIVITY_PROMPT_COUNT nudges). endBehavior stays default (never hang up)
    // unless `options.inactivity.hangup` opts in, in which case the LAST entry
    // carries END_BEHAVIOR_HANG_UP_SOFT so the model still delivers that prompt
    // before ending. Native entries above win.
    let inactivitySecs = Ultravox.inactivityTimeoutSecs(inactivity);
    if (!data.inactivityMessages && inactivitySecs) {
      let entry = { duration: `${inactivitySecs}s`, message: inactivity.message.trim() };
      let messages = Array.from({ length: Ultravox.INACTIVITY_PROMPT_COUNT }, () => ({ ...entry }));
      inactivity.hangup === true &&
        (messages[messages.length - 1] = { ...entry, endBehavior: 'END_BEHAVIOR_HANG_UP_SOFT' });
      data.inactivityMessages = messages;
    }

    logger.debug({ data }, 'Getting Ultravox data');
    return data;
  }


}


export default Ultravox;
