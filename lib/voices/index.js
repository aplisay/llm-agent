import Google from './google.js';
import Deepgram from './deepgram.js';
import XiLabs from './xilabs.js';
import Neuphonic from './neuphonic.js';
import Cartesia from './cartesia.js';
import defaultLogger from '../logger.js';
import { withinMs } from './catalogue-cache.js';

const logger = defaultLogger.child({ module: 'voices' });
const implementations = [
  './google.js',
  './deepgram.js',
  './xilabs.js',
  './neuphonic.js',
  './cartesia.js',
];

class Voices {

  // Longer than a cold Cartesia load (about 3 s), so a vendor is only left out when it is stuck.
  static vendorDeadlineMs = 8000;

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
      Object.entries(services).map(async ([name, entry]) => {
        const voices = entry.listVoices().catch((error) => {
          logger.error(error, 'error listing voices');
          return [];
        });
        return [name, await withinMs(voices, Voices.vendorDeadlineMs, () => {
          logger.warn({ vendor: name, ms: Voices.vendorDeadlineMs }, 'voice catalogue too slow; vendor left out of this list');
          return [];
        })];
      })
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
