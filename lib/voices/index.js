const Google = require('./google.js');
const Deepgram = require('./deepgram.js');
const XiLabs = require('./xilabs.js');
const Aws = require('./aws.js');
const Jambonz = require('../jambonz.js');

const dontProbeJambonz = process.env.DONT_CHECK_JAMBONZ_VOICES;

/**
 *
 *
 * @class GoogleHelper
 */
class Voices {
  constructor(logger) {
    this.logger = logger.child({ voices: true });
    this.clients = {
      google: new Google(logger),
      deepgram: new Deepgram(logger),
      elevenlabs: new XiLabs(logger),
      aws: new Aws(logger)
    }
    this.jambonz = new Jambonz(logger, 'voices');
    this.services = dontProbeJambonz || this.jambonz.getCredentials().then(
      credentials => credentials?.map(credential => credential.use_for_tts && credential.tts_tested_ok && credential.vendor).filter(c => !!c)
    )
  }

  /**
   *  Get all of the Provider TTS voices
   *
   * @return {[][]} All Jambonz number resources on the instance
   */
  async listVoices() {
    let list = {};
    let services = await this.services;
    for (let [name, entry] of Object.entries(this.clients)) {
      (dontProbeJambonz || !!services.find(service => service === name)) && (list[name] = await entry.listVoices());
    }
    this.logger.debug({ list, services, raw: await this.services }, 'LIST');
    return list;
  }
}

module.exports = Voices;
