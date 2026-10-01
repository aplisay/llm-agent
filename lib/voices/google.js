import speak from '../utils/speak.js';
import { catalogueCache } from './catalogue-cache.js';

// Imports the Google Cloud client library
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// Import other required libraries
import fs from 'fs';
import util from 'util';

// One client for the process: each new one opens its own gRPC channel.
let client;

/** Every Google voice, by language code. Uncached; see googleCatalogue. */
async function loadGoogleVoices() {
  client ||= new TextToSpeechClient();
  const response = await client.listVoices({});
  let [{ voices }] = response;
  let languageCodes = voices.reduce(
    (o, l) => (l.languageCodes.forEach((code) => (o[code] = true)), o),
    {}
  );
  let tree = Object.fromEntries(
    Object.keys(languageCodes).map((code) => [
      code,
      Object.values(
        Object.fromEntries(
          voices
            .filter((voice) => voice.languageCodes.find((l) => l === code))
            .map((v) => [
              v?.name,
              {
                name: v?.name,
                description: v?.name,
                gender: v?.ssmlGender?.toLowerCase(),
              },
            ])
        )
      ),
    ])
  );
  return tree;
}

const googleCatalogue = catalogueCache({ name: 'google', load: loadGoogleVoices });

/** Forget the cached catalogue (tests). */
export const resetGoogleVoicesCache = () => googleCatalogue.reset();

/**
 *
 *
 * @class GoogleHelper
 */
class GoogleHelper {

  static name = 'google';
  static description = 'Google TTS';
  constructor(logger) {
    this.logger = logger.child({ googleHelper: true });
  }

  get useSsml() {
    return true;
  }
  get speak() {
    this.logger.debug({ speak, ssml: speak.ssml }, "speak values");
    return speak.ssml;
  }

  /**
   *  Get all of the Google TTS voices
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof GoogleHelper
   */
  async listVoices(languageCode) {
    const tree = await googleCatalogue.get({ logger: this.logger });
    return languageCode
      ? Object.fromEntries(Object.entries(tree).filter(([code]) => code.startsWith(languageCode)))
      : tree;
  }
}

export default GoogleHelper;
