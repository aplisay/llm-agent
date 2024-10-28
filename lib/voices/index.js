const Google = require('./google.js');
const Deepgram = require('./deepgram.js');
const XiLabs = require('./xilabs.js');
const defaultLogger = require('../logger.js');
const logger = defaultLogger.child({module: 'voices'});

class Voices {

  static services = {
    google: new Google(logger),
    deepgram: new Deepgram(logger),
    elevenlabs: new XiLabs(logger)
  };

  static list = Promise.all(Object.entries(Voices.services).map(async ([name, entry]) =>
    ([name, await entry.listVoices()])))
    .then((entries) => {
      logger.debug(entries, 'listVoices entries');
      return Object.fromEntries(entries);
    });

  /**
   *  Get all of the Provider TTS voices
   *
   */
  async listVoices() {
    logger.debug({ voices: Object.keys(await Voices.list).length }, 'listVoices got');
    return await Voices.list;
  }
}

module.exports = Voices;
