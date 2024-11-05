const { Agent, Instance, Call, TransactionLog, PhoneNumber } = require('../../../lib/database.js');
const JambonzSession = require('./session.js');
const logger = require('../../../lib/logger.js');
const Jambonz = require('../../../lib/jambonz.js');
const Handler = require('../../../lib/handlers/jambonz');

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
        let calledId = session.to.replace(/^\+/, '');
        let callerId = session.from;
        logger.info({ session, callerId, calledId }, 'new Jambonz call');
        const { number, instance, agent } = await Agent.fromNumber(calledId);
        if (instance) {
          logger.info({ number, agent, instance, session }, 'Found instance for call');
          const { model } = new Handler({ logger, agent });
          let call = this.call = await Call.create({
            instanceId: instance.id,
            agentId: agent.id,
            calledId,
            callerId,
          });
          let callId = call.id;;
          let sessionHandler = this.sessionHandler = new JambonzSession({
            ...this,
            session,
            model,
            voices: await Handler.voices,
            logger,
            options: agent.options,
            progress: {
              send: async (data) => {
                try {
                  data.call && call.start();
                  await TransactionLog.create({
                    callId, type: Object.keys(data)?.[0], data: JSON.stringify(Object.values(data)?.[0])
                  });
                }
                catch (err) {
                  logger.info(err, 'error in call progress logging');
                  sessionHandler.forceClose();
                }
              }
            }
          });
          await sessionHandler.handler();
          call.end();
        }
        else {
          logger.info({ calledId }, 'No instance for call');
        }
      }
      catch (err) {
        logger.info(err, 'error in call progress');
        await this.sessionHandler.forceClose();
        this.call && this.call.end();
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
            let res = await jambonz.addNumber({ number, carrier, application });
            logger.info({ res }, 'created number on Jambonz');
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
    logger.debug({ applications }, 'loaded applications');
    this.application = applications
      .find(a => a?.call_hook?.url === `wss://${host}${path}`)
      ?.application_sid;
    if (this.application) {
      logger.debug({ application: this.application }, 'found Jambonz application');
    }
    else {
      logger.debug('no Jambonz application: creating');
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
    logger.debug({ carriers }, 'loaded carriers');
    this.carrier = (carriers.length == 1 ? carriers[0] : carriers.find(c => c.name === 'Aplisay'))?.voip_carrier_sid;
    return this.carrier;
  }


  async clean() {
    // Actively terminate any existing call sessions
    this.socket?.close && this.socket.close();
  }

}

module.exports = Application;