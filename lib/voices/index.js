import Google from './google.js';
import Deepgram from './deepgram.js';
import XiLabs from './xilabs.js';
import defaultLogger from '../logger.js';

const logger = defaultLogger.child({ module: 'voices' });
const implementations = [
  './google.js',
  './deepgram.js',
  './xilabs.js',
];

class Voices {

  static services = async () =>
    Object.fromEntries(await Promise.all(
      implementations.map(async (impl) => {
        const { default: Implementation } = await import(impl);
        return [Implementation.name, new Implementation(logger)];
      })
    ));

  static list = async () => {
    const services = await Voices.services();
    const entries = await Promise.all(
      Object.entries(services).map(async ([name, entry]) => 
        [name, await entry.listVoices().catch((error) => {
          logger.error(error, 'error listing voices');
          return [];
        })]
      )
    );
    return Object.fromEntries(entries);
  };

  /**
   *  Get all of the Provider TTS voices
   *
   */
  async listVoices() {
    return await Voices.list();
  }

  get availableVoices() {
    return Voices.list();
  }
}

export default Voices;
