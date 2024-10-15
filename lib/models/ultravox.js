require('dotenv').config();
const axios = require('axios');
const Llm = require('./llm');
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

  static handler = 'ultravox';

  static allModels = [
    ["fixie-ai/ultravox-8B", "Ultravox 8B"],
    ["fixie-ai/ultravox-70B", "Ultravox 70B"]
  ];

  static needKey = { ULTRAVOX_API_KEY };

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
    let { modelName } = args;
    let [,model] = modelName.split(':');
    this.api = api;
    this.model = model || Ultravox.allModels[0][0];
    this.logger.info({ args }, 'NEW Ultravox agent');
  }

  set prompt(newPrompt) {
    this?.logger?.debug({ newPrompt }, 'Setting prompt');
    this._prompt = newPrompt;
    let system = this.gpt?.messages?.find(m => m.role === 'system');
    system && (system.content = this._prompt);
  }

  set functions(functions) {
    this?.logger?.debug({ functions }, 'Setting functions');
    this.tools = functions && functions.map(({ name, description, url, method, input_schema: { properties } }) => ({
      nameOverride: name,
      temporaryTool: {
        description,
        http: {
          baseUrlPattern: url,
          httpMethod: method?.toUpperCase()
        },
        dynamicParameters: (properties && Object.keys(properties).length > 0 &&
          Object.entries(properties).map(([name, { description, type, required, in: location }]) => ({
            name,
            location: LOCATION[location] || LOCATION.default,
            schema: {
              type,
              description
            },
            required
          }))) || undefined
      }
    }));
  }

  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = newOptions;
  }
  get options() {
    return this._options;
  }


  async activate(instanceId) {

    let { _prompt: systemPrompt, _options, logger, model, tools } = this;
    let { temperature, voice } = _options || {};
    logger.info({ systemPrompt, _options, model, tools, self: this  }, 'Activating Ultravox agent');


    try {
      let callData = {
        model,
        systemPrompt,
        selectedTools: tools,
        temperature,
        voice
      };
      logger.info(callData, 'Starting inband call');
      let { data: {
        callId,
        ended,
        joinUrl
      } } = await api.post('calls', callData);
      if (ended || !callId?.length || !joinUrl?.length) {
        throw new Error('API call failed');
      }
      this.callId = callId;
      logger.info({ self: this }, 'In band call started');
      return { id: instanceId, ultravox: { joinUrl } };

    }
    catch (error) {
      console.error(error);
      throw new Error(`Call setup: ${error.message}`);
    }


  }

  async destroy() {

    let { callId, logger } = this;
    logger.info({ callId }, 'Inband call ending');

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

}


module.exports = Ultravox;
