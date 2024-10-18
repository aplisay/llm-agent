const { Agent, Instance, TransactionLog } = require('./database');

const Claude = require('./models/anthropic');
const OpenAi = require('./models/openai');
const Groq = require('./models/groq');
const Palm2 = require('./models/palm2');
const Gemini = require('./models/gemini');
const Ultravox = require('./models/ultravox');
const Livekit = require('./models/livekit');
const uuid = require('uuid').v4;

class Application {

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
  constructor({ wsServer, logger }) {
    logger.info({ wsServer }, 'Application create wsServer WS with voices');
    Object.assign(this, { wsServer, logger });
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
    },
    'claude': {
      implementation: Claude,
      description: "Anthropic Claude 3 Haiku",
    },
    'palm2': {
      implementation: Palm2,
      description: "Google PaLM2",
    },
    'gemini': {
      implementation: Gemini,
      description: "Google Gemini 1.5 Pro Preview",
    },
    'opensource': {
      implementation: Groq,
      description: "Llama",
    },
    'ultravox': {
      implementation: Ultravox,
      description: "Ultravox Llama",
    },
    'livekit': {
      implementation: Livekit,
      description: "Various",
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
        .map(async ([key, { implementation }]) =>
        (await Promise.all(
          implementation?.allModels?.map(
            async ([model, description]) => ([`${key}:${model}`, {
              description,
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

  async load(id) {
    this.agent = await Agent.findOne({ where: { id } });
  }

  async activate({ number, options = {} } = {}) {
    let { streamLog = false } = options;

    let {agent, wsServer, logger, callbackUrl} = this;
    if (!this.agent.id) {
      throw new Error('No current agent');
    }
    let { id } = agent;
    let progressPath = `/progress/${id}`;
    logger.info({ agent, streamLog, options }, `activating agent ${agent.id} with number ${number}`);
    let [model] = agent.modelName.split(':');
    let type = Application.models[model].handler;
    let llm = new Application.models[model]({ logger, ...agent.dataValues });
    // todo allocate/validate number
    let instance = Instance.build({ agentId: agent.id, type, sipNumber: number, streamLog });
    await instance.save();

    this.progress = { send: () => (null) };
    wsServer.createEndpoint(progressPath, (ws) => {
      this.ws = ws;
      ws.send(JSON.stringify({ hello: true }));
      this.progress = {
        send: async (msg) => {
          logger.info({ msg }, 'sending message');
          ws.send(JSON.stringify(msg));
          callbackUrl && this.callbackTries > 0 && axios.post(callbackUrl, msg).catch((e) => {
            --this.callbackTries || this.logger.error({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback disabled');
            this.logger.info({ callbackUrl, tries: this.callbackTries, error: e.message }, 'Callback failed');
          });
        }
      };
      ws.on('error', (err) => {
          this.logger.error({ err }, `received socket error ${err.message}`);
        })
        .on('close', (code, reason) => {
          this.logger.info({ code, reason }, `socket close`);
          this.destroy();
        });
    });

    let activation = (llm.activate && await llm.activate(instance.id)) || {};
    logger.info({ id: instance.id }, `activation result`);
    TransactionLog.on(instance.id, async (transactionLog) => {
      logger.info({ transactionLog }, `Got transactionlog`);
      this.progress.send(
        transactionLog
      );
    });





    return {...activation, socket: progressPath}
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
   * Find a number that isn't currently linked to an application and link it to this one
   * 
   * @returns {Object} Jambonz number object of the new number
   */
  async #allocateNumber() {
    // Todo
    return;

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
      Application.live = Application.live?.filter(a => a.name !== this.name);
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