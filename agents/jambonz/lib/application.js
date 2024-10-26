const { Agent, Instance, Call, PhoneNumber } = require('../../../lib/database.js');
const JambonzSession = require('./session.js');
const logger = require('../../../lib/logger.js');
const Jambonz = require('./jambonz.js');
const Model = require('../../../lib/model.js');

/**
 *
 * @param {*} options
 * @return {*} 
 */
class Application {
  constructor({ socket, host, path, logger }) {
    Object.assign(this, { socket, host, path, logger });
    logger.info({ host, path, socket }, 'new application');
    this.jambonz = new Jambonz(logger, 'worker');
    socket.on('session:new', async (session) => {
      try {
        let called_number = session.to.replace(/^\+/, '');
        logger.info({ session, called_number }, 'new Jambonz call');
        const { number, instance, agent } = await Agent.fromNumber(called_number);
        logger.info({ number, agent, instance, session }, 'Found instance for call');
        let [model] = agent.modelName.split(':');
        const llmClass = Model.agents[model].implementation;
        if (instance) {
          this.call = await Call.create({ instanceId: instance.id, callerId: instance.id });
          let callId = session.call_sid;
          let s = new JambonzSession({
            ...this,
            session,
            agent: new llmClass({ logger, user: session.call_sid, model, ...agent }),
            options: agent.options
          });
          await s.handler();
        }
        else {
          logger.info({ called_number }, 'No instance for call');
        }
      }
      catch (err) {
        logger.error(err, 'error getting instance for callllM');
      }
    });
  }

  async loadNumbers() {
    const { jambonz, logger } = this;
    try {
      const phoneNumbers = await PhoneNumber.findAll({ where: { handler: 'jambonz' } });
      const jambonzNumbers = await jambonz.listNumbers() || {};
      logger.debug({ phoneNumbers, jambonzNumbers }, 'loaded database & Jambonz numbers');
      let carrier = this.carrier || await this.loadCarrier();
      let application = this.application || await this.loadApplication();

      return Promise.all(
        phoneNumbers.map(async phoneNumber => {
        let { number } = phoneNumber;
        if (!jambonzNumbers.find(n => n?.number === number)) {
          logger.info({ number, carrier, application }, 'creating number on Jambonz');
          await jambonz.addNumber({ number, carrier, application });
        }
        return number;
        })
      );
    }
    catch (err) {
      logger.error(err, 'error loading numbers');
    }
  }


  async loadApplication() {
    const { host, path, jambonz } = this;
    const applications = await jambonz.listApplications();
    logger.info({ applications }, 'loaded applications');
    this.application = applications
      .find(a => a?.call_hook?.url === `wss://${host}${path}`)
      ?.application_sid;
    if (this.application) {
      logger.debug({ application: this.application }, 'found Jambonz application');
    }
    else {
      logger.info('no Jambonz application: creating');
      this.application = (await jambonz.addApplication({
        name: `Aplisay Handler ${host}`,
        url: `wss://${host}${path}`
      }))?.application_sid;
    }
    return this.application;
  }

  async loadCarrier() {
    const { jambonz } = this;
    const carriers = await jambonz.listCarriers();
    logger.info({ carriers }, 'loaded carriers');
    this.carrier = (carriers.length == 1 ? carriers[0] : carriers.find(c => c.name === 'Aplisay'))?.voip_carrier_sid;
    return this.carrier;
  }


  async clean() {
    // Actively terminate any existing call sessions
    this.socket?.close && this.socket.close();
  }

}

module.exports = Application;
