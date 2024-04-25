const Google = require('./google.js');
const Deepgram = require('./deepgram.js');
const XiLabs = require('./xilabs.js');



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
      elevenlabs: new XiLabs(logger)
    }
  }

  /**
   *  Get all of the Provider TTS voices
   *
   * @return {[][]} All Jambonz number resources on the instance
   */
  async listVoices(languageCode = null) {
    let list = {};
    for (let [name, entry] of Object.entries(this.clients)) {
      list[name] = await entry.listVoices(languageCode)
    }
    return list;
  }
}

module.exports = Voices;
