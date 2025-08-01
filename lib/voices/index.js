import Google from './google.js';
import Deepgram from './deepgram.js';
import XiLabs from './xilabs.js';
import defaultLogger from '../logger.js';

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
      return Object.fromEntries(entries);
    });

  /**
   *  Get all of the Provider TTS voices
   *
   */
  async listVoices() {
    return await Voices.list;
  }

  get availableVoices() {
    return Voices.list;
  }
}

export default Voices;
