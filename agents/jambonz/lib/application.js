const { Agent, Call, PhoneNumber } = require('../agent-lib/database.js');
const JambonzSession = require('./session.js');
const logger = require('../agent-lib/logger.js');
const Jambonz = require('../agent-lib/jambonz.js');
const handlers = require('../agent-lib/handlers');

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
          let { userId, organisationId, options: {fallback: {number: fallbackNumbers} = {} } = {} } = agent;
          logger.info({ number, agent, instance, session }, 'Found instance for call');
          let Handler = handlers.getHandler(agent.modelName);
          let handler = new Handler({ logger, agent, instance });
          let { model } = handler;
          let room = handler.join && await handler.join(
            {
              websocket: true,
              telephony: true,
            }
          );
          let { ultravox } = room || {};
          let { joinUrl: streamUrl } = ultravox || {};
          logger.debug({ streamUrl, room, ultravox }, 'application handler');

          let call = this.call = await Call.create({
            userId,
            organisationId,
            id: session.call_sid,
            instanceId: instance.id,
            agentId: agent.id,
            streamUrl,
            calledId,
            callerId,
            metadata: {
              ...instance.metadata,
              aplisay: {
                callerId,
                calledId,
                fallbackNumbers,
                model: agent.modelName,
              }
            }
          });
          let callId = call.id;
          let sessionHandler = this.sessionHandler = new JambonzSession({
            instanceId: instance.id,
            callId,
            streamUrl,
            ...this,
            session,
            model,
            voices: await Handler.voices,
            logger,
            options: agent.options,
            progress: {
              send: async (data, isFinal = true) => {
                try {
                  data.call && call.start();
                  await handler.transcript({
                    callId, type: Object.keys(data)?.[0], data: JSON.stringify(Object.values(data)?.[0])
                  });
                }
                catch (err) {
                  logger.info(err, 'error in call progress logging');
                  //sessionHandler.forceClose();
                }
              }
            }
          });
          await sessionHandler.handler();
          logger.debug({ callId }, 'session ended');
          call.end();
        }
        else {
          logger.info({ calledId }, 'No instance for call');
        }
      }
      catch (err) {
        logger.info(err, 'error in call progress');
        this.sessionHandler && await this.sessionHandler.forceClose();
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
