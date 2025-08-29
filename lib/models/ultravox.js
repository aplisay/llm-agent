import axios from 'axios';
import Llm from './llm.js';
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
  static name = 'fixie-ai';

  static allModels = [
    ["fixie-ai/ultravox-8B", "Ultravox 8B"],
    ["fixie-ai/ultravox-70B", "Ultravox 70B"]
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
   * Ultravox supports function calling only with 70B model   *
   * @static 
   * @memberof OpenAi
   */
  static supportsFunctions = (model) => !!model.match(/-70B$/i);

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
    this.model = model || Ultravox.allModels[0][0];
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
            timeout: '6s',
            http: implementation === 'rest' ? {
              baseUrlPattern: pUrl?.href,
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
                required
              }))) || undefined,
            staticParameters: [...staticParameters, 
              ...Object.entries(properties)
                .filter(([, { source }]) => source === 'static' || source === 'metadata')
                .map(([name, { description, source, from, type, required, in: location }]) => {
                  let value = (source === 'metadata' ? metadata?.[from.split('.')[0]]?.[from.split('.')[1]] : from) || '';
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
   * Get the model data for the LLM. This model instation data in a form which can be used
   * to instantiate an agent in thier `call` rest endpoint.
   *
   * @readonly
   * @memberof Ultravox
   */
  get modelData() {
    let { _prompt: systemPrompt, _options, logger, model, tools } = this;
    let { temperature, voice, maxDuration, timeExceededMessage } = _options || {};
    let data = {
      model,
      maxDuration: maxDuration || '305s',
      timeExceededMessage: timeExceededMessage || 'It has been great chatting with you, but we have exceeded our time now.',
      systemPrompt,
      selectedTools: tools,
      temperature,
      voice,
      transcriptOptional: false,
    };
    logger.debug({ data }, 'Getting Ultravox data');
    return data;
  }


}


export default Ultravox;
