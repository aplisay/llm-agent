const Mutex = require('async-mutex').Mutex;
const Jambonz = require('../lib/jambonz');
const defaultPrompts = require('../data/defaultPrompts');

const Claude = require('./models/anthropic');
const OpenAi = require('./models/openai');
const Groq = require('./models/groq');
const Palm2 = require('./models/palm2');
const Gemini = require('./models/gemini');
const Ultravox = require('./models/ultravox');
const Livekit = require('./models/livekit');
const Agent = require('./agent');
const uuid = require('uuid').v4;

class Application {

  /**
   * List of all live applications instantiated by this server
   *
   * @static
   * @memberof Application
   */
  static live = [];

  /**
   * Create a new application 
   * 
   * @param {Object} params Application creation parameters
   * @param {string} params.modelName supported LLM agent name, must be one of #Application.agents
   * @param {Object} params.wsServer  An HTTP server object to attach an progress websocket to   
   * @param {Function} params.makeService  A Jambonz WS SDK makeServer Function
   * @param {Object} params.options Options object to pass down to the underlying LLM agent
   * @param {Object} params.logger Pino logger instance
   * @param {string} params.name Globally unique id for this agent instance, receives a new uuid.v4 if not set
   * @param {string} params.prompt Initial (system) prompt to the agent
   *  
   */
  constructor({ modelName, wsServer, makeService, options, logger, name, prompt, functions, callbackUrl, voices }) {
    let [implementationName, model] = (modelName && modelName.split(':')) || [];
    let m;
    if (!Application.agents[implementationName] || !Application.agents[implementationName].implementation.allModels.find(([name]) => name === model)) {
      throw new Error(`Bad agent implementation ${implementationName} must be one of ${Object.keys(Application.agents)}`);
    }
    if (functions && !Application.agents[implementationName]?.implementation?.supportsFunctions(model)) {
      throw new Error(`Application has functions list, but model ${model} doesn't support functions`);
    }
    logger.info({ wsServer, voices }, 'Application create wsServer WS with voices');
    Object.assign(this, { implementationName, model, wsServer, makeService, logger, options, prompt, functions, callbackUrl, voices });
    this._prompt = prompt || Application.agents[implementationName].defaultPrompt;
    this._options = options;
    this.name = name || uuid();
    this.id = `LLM-${this.implementationName}-${this.name}`;
    if (!Application.agents[implementationName].audioModel) {
      logger.info({ implementationName, audioModel: Application.agents[implementationName].audioModel }, 'Application create jambonz');
      // direct to audio models go nowhere near jambonz
      this.jambonz = new Jambonz(this.logger, this.name);
    }
    Application.live.push(this);
  }

  set prompt(newPrompt) {
    this._prompt = newPrompt;
    this.agent && (this.agent.prompt = newPrompt);
  }

  get prompt() {
    return this._prompt;
  }

  set options(newOptions) {
    this._options = newOptions;
    this.agent && (this.agent.options = newOptions);
  }

  get options() {
    return this._options;
  }

  /**
   * Find the application corresponding to an ID
   *
   * @static
   * @param {string} id
   * @return {Application} 
   * @memberof Application
   */
  static recover(id) {
    return Application.live.find(a => (a.id === id || a.agent.callId === id));
  }

  /**
   * All of the current agent types we can handle keyed by short identifier
   *
   * @static
   * @memberof Application
   */
  static agents = {
    'openai': {
      implementation: OpenAi,
      description: "OpenAI GPT3.5-turbo",
      defaultPrompt: defaultPrompts.gpt
    },
    'claude': {
      implementation: Claude,
      description: "Anthropic Claude 3 Haiku",
      defaultPrompt: defaultPrompts.gpt
    },
    'palm2': {
      implementation: Palm2,
      description: "Google PaLM2",
      defaultPrompt: defaultPrompts.google
    },
    'gemini': {
      implementation: Gemini,
      description: "Google Gemini 1.5 Pro Preview",
      defaultPrompt: defaultPrompts.google
    },
    'opensource': {
      implementation: Groq,
      description: "Llama",
      defaultPrompt: defaultPrompts.gpt
    },
    'ultravox': {
      implementation: Ultravox,
      description: "Ultravox Llama",
      defaultPrompt: defaultPrompts.gpt
    },
    'livekit': {
      implementation: Livekit,
      description: "Various",
      defaultPrompt: defaultPrompts.gpt
    }
  };

  static get models() {
    return this._models || (this._models = Object.fromEntries(
      Object.entries(Application.agents)
     .filter(([key, value]) => value.implementation.allModels)
     .map(([key, value]) => [key, value.implementation])));
  }

  /**
   * List of available agent types
   * 
   * @returns {Object[]} agents
   */
  static async listModels() {
    let agentImplementations = Object.entries(Application.agents)
      .filter(([key, value]) => (!!value.implementation && value.implementation.canLoad(value.implementation.needKey).ok));
    let models = Object.fromEntries(
      (await Promise.all(agentImplementations
        .map(async ([key, { implementation, defaultPrompt }]) =>
        (await Promise.all(
          implementation?.allModels?.map(
            async ([model, description]) => ([`${key}:${model}`, {
              description,
              defaultPrompt,
              voices: implementation.voices && await implementation.voices,
              supportsFunctions: implementation.supportsFunctions(model),
              audioModel: implementation.audioModel === true
            }])
          )
        )
        )
        )))
        .flat()
        .sort(([,a], [,b]) => new Intl.Collator('en').compare(a.description, b.description))
    );
    return models;
  }

  /**
   * Create a new application by instantiating a local Jambonz WS listener on a 
   * UUID keyed path, then creating a Jambonz application which calls it.
   * Then finds a phone number not currently linked to an application and links it to this one.
   *  
   * @returns {string} textual phone number linked to the new application
   */
  async create() {
    let llmClass = Application.agents[this.implementationName].implementation;
    let { prompt, options, functions, logger, model } = this;

    try {

      if (!llmClass.audioModel) {
        this.logger.info({ name: this.name, jambonz: this.jambonz }, 'creating phone application');
        this.agent = new Agent({
          ...this,
          prompt: this.prompt,
          options: this.options,
          functions: this.functions,
          llmClass,
          handleClose: () => this.destroy()
        });
        let { sid } = await this.jambonz.addApplication({
          name: this.id,
          url: `wss://${process.env.SERVER_NAME}/agent/${this.name}`,
          ...this.options
        });
        this.application = await this.jambonz.getApplication(sid);
        this.logger.info({ application: this.application }, 'created Jambonz application');
        await this.#allocateNumber();
        if (!this.number) {
          this.destroy();
        }
        return { number: this.number?.number, id: this.id, socket: this.agent?.socketPath };
      }
      else {
        this.logger.info({ name: this.name, model }, 'creating inband application');
        this.agent = new llmClass({ prompt, options, functions, logger, model });
        return { ...await this.agent.startInband(), id: this.id };
      }
    }
    catch (e) {
      logger.error({ e }, `couldn\'t create agent: ${e?.message}`);
      throw e;
    }


  }

  /**
   * allocateNumber queries Jambonz for a list to get a free number then link it. There is a race condition here.
   * Resolved the lazy way by putting a great big mutex around the whole operation. 
   * Semlocked local registry would be better.
   *
   * @static
   * @memberof Application
   */
  static #allocateMutex = new Mutex();


  /**
   * Find a number that isn't currently linked to an application and link it to this one
   * 
   * @returns {Object} Jambonz number object of the new number
   */
  async #allocateNumber() {

    await Application.#allocateMutex.runExclusive(async () => {
      if (!this.application) {
        console.error(this);
        throw new Error(`application to assign a number`);
      }
      for (let tries = 0; !this.number && tries < 3; tries++) {
        let candidate;
        try {

          candidate = (await this.jambonz.listNumbers()).find(n => !n.application_sid);
          if (!candidate) {
            throw new Error('No spare numbers');
          }
          else {
            await this.jambonz.updateNumber(candidate.phone_number_sid, { application: this.application.application_sid });
            this.number = await this.jambonz.getNumber(candidate.phone_number_sid);
          }
        }

        catch (e) {
          this.logger.error({ e, candidate, application: this.application }, 'Error');
        }
      }
    });

    return this.number;

  }

  /**
   * Delete this Jambonz application
   *
   * @memberof Application
   */
  async destroy() {
    try {
      this.agent && await this.agent.destroy();
      delete this.agent;
      this.number && this.number.phone_number_sid && await this.jambonz.updateNumber(this.number.phone_number_sid, { application: false });
      delete this.number;
      this.application && this.application.application_sid && await this.jambonz.deleteApplication(this.application.application_sid);
      delete this.application;
    }
    catch (error) {
      this.logger.error({ error, jambonzApplication: this.application }, 'Application destroy');
    }
    finally {
      Application.live = Application.live.filter(a => a.name !== this.name);
    }
  }

  /**
   * Destroy all initialised applications created by this application
   * 
   * @static
   * @return {Promise} resolves when all applications have been removed from the Jambonz instance
   * @memberof Application
   */
  static async clean() {
    return Promise.all(Application.live.map(application => application.destroy()));
  }


  /**
   * Really aggressively scour the Jambonz instance for anything that looks like
   * an auto created application of ours, unlink the phone number and delete the application
   *
   * @static
   * @memberof Application
   */
  static async cleanAll() {
    let logger = require('./logger');
    let jambonz = new Jambonz(logger, 'no-user');
    let numbers = await jambonz.listNumbers();
    let applications = (await jambonz.listApplications()).filter(a => a.name.match(/^LLM[a-z0-9-]+/));
    for (let application of applications) {
      await Promise.all(numbers.filter(n => n.application_sid === application.application_sid).map(n => jambonz.updateNumber(n.phone_number_sid, { application: false })));
      await jambonz.deleteApplication(application.application_sid);
      logger.info({ application }, "deleted");
    }
  }

}

module.exports = Application;