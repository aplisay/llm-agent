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

let mutex = new Mutex();

class Application {

  constructor({ agentName, makeService, options, logger }) {
    if (!agents[agentName]) {
      throw new Error(`Bad agent name ${agentName} must be one of ${Object.keys(agents)}`);
    }
    Object.assign(this, { agentName, makeService, logger, options });
    this.name = uuid();
    this.jambonz = new Jambonz(this.logger, this.name);
  }

  static listAgents() {
    return Object.entries(agents);
  }

  async create() {

    console.log({ ...this, llmClass: agents[this.agentName].implementation });

    agent({ ...this, llmClass: agents[this.agentName].implementation});
    // This really needs some sort of semlock around it as two competing threads could both
    let { sid } = await this.jambonz.addApplication({
      name: `LLM-${this.agentName}-${this.name}`,
      url: `wss://${process.env.SERVER_NAME}/agent/${this.name}`,
      ...this.options
    });
    this.application = await this.jambonz.getApplication(sid);
    this.logger.info({ application: this.application }, 'created Jambonz application');
    await this.allocateNumber();
    return this.number.number;

  }

  async allocateNumber() {
    await mutex.runExclusive(async () => {

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
          this.logger.error({ candidate, application: this.application , e }, 'Error');
        }

      }
    });

    return this.number;

  }

  async destroy() {

    this.number && await this.jambonz.updateNumber(this.number.phone_number_sid, { application: false });
    delete this.number;
    this.application && await this.jambonz.deleteApplication(this.application.application_sid);
    delete this.application;
    console.log({ application: this }, 'application');

  }

}

module.exports = Application;