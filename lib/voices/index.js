const Google = require('./google.js');
const Deepgram = require('./deepgram.js');
const XiLabs = require('./xilabs.js');
const Jambonz = require('../jambonz.js');
const defaultLogger = require('../logger.js');

/**
 *
 *
 * @class Voices
 */
class Voices {
  constructor(logger = defaultLogger) {
    this.logger = logger.child({ voices: true });
    this.services = {
      google: new Google(logger),
      deepgram: new Deepgram(logger),
      elevenlabs: new XiLabs(logger)
    }
  }

  /**
   *  Get all of the Provider TTS voices
   *
   * @return {[][]} All Jambonz number resources on the instance
   */
  async listVoices() {
    let list = {};
    let { services, logger } = this;
    for (let [name, entry] of Object.entries(this.services)) {
      list[name] = await entry.listVoices();
    }
    return list;
  }
}

module.exports = Voices;
