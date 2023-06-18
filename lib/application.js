const Mutex = require('async-mutex').Mutex;
const Jambonz = require('../lib/jambonz');

const Gpt35 = require('./gpt35');
const Palm2 = require('./palm2');
const agent = require('./agent');
const uuid = require('uuid').v4;


agents = {
  'gpt35': {
    implementation: Gpt35,
    description: "GPT3.5-turbo chat"
  },
  'palm2': {
    implementation: Palm2,
    description: "Google PaLM2 (BARD via Vertex AI)"
  }
};


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
   * @param {*} param0 
   */
  constructor({ agentName, makeService, options, logger, name }) {
    if (!Application.agents[agentName]) {
      throw new Error(`Bad agent name ${agentName} must be one of ${Object.keys(agents)}`);
    }
    Object.assign(this, { agentName, makeService, logger, options });
    this.name = name || uuid();
    this.id = `LLM-${this.agentName}-${this.name}`;
    this.jambonz = new Jambonz(this.logger, this.name);
    Application.live.push(this);
  }

  static recover(id) {
    return Application.live.find(a => a.id === id);
  }

  /**
   * All of the current agent types we can handle keyed by short identifier
   *
   * @static
   * @memberof Application
   */
  static agents = {
    'gpt35': {
      implementation: Gpt35,
      description: "GPT3.5-turbo chat"
    },
    'palm2': {
      implementation: Palm2,
      description: "Google PaLM2 (BARD via Vertex AI)"
    }
  };

  /**
   * List of available agent types
   * 
   * @returns 
   */
  static listAgents() {
    return Object.entries(agents);
  }

  /**
   * Create a new application by instantiating a local Jambonz WS listener on a 
   * UUID keyed path, then creating a Jambonz application which calls it.
   * Then finds a phone number not currently linked to an application and links it to this one.
   *  
   * @returns textual phone number linked to the new application
   */
  async create() {

    agent({ ...this, llmClass: Application.agents[this.agentName].implementation });
    // This really needs some sort of semlock around it as two competing threads could both
    let { sid } = await this.jambonz.addApplication({
      name: this.id,
      url: `wss://${process.env.SERVER_NAME}/agent/${this.name}`,
      ...this.options
    });
    this.application = await this.jambonz.getApplication(sid);
    this.logger.info({ application: this.application }, 'created Jambonz application');
    await this.allocateNumber();
    return this.number?.number;

  }

  /**
   * allocateNumber queries Jambonz for a list to get a free number then link it. There is a race condition here.
   * Resolved the lazy way by putting a great big mutex around the whole operation. 
   * Semlocked local registry would be better.
   *
   * @static
   * @memberof Application
   */
  static allocateMutex = new Mutex();


  /**
   * Find a number that isn't currently linked to an application and link it to this one
   * 
   * @returns Jambonz number object of the new number
   */
  async allocateNumber() {

    await Application.allocateMutex.runExclusive(async () => {
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
          this.logger.error({ candidate, application: this.application, e }, 'Error');
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
    this.number && await this.jambonz.updateNumber(this.number.phone_number_sid, { application: false });
    delete this.number;
    this.application && await this.jambonz.deleteApplication(this.application.application_sid);
    delete this.application;
  }

  /**
   * Destroy all initialised applications created by this application
   * 
   * @static
   * @return {*} 
   * @memberof Application
   */
  static async clean() {
    return Promise.all(Application.live.map(application => application.destroy()));
  }


  /**
   * Really aggressively scour the Jambonz instance for anything that looks like
   * an auto created application of ours, unlink the phone number and delete the application
   *
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