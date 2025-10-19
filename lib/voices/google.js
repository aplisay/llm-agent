import speak from '../utils/speak.js';

// Imports the Google Cloud client library
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// Import other required libraries
import fs from 'fs';
import util from 'util';

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
    this.client = new TextToSpeechClient();
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
    // Construct request
    const request = {
      languageCode
    };
    const { client, logger } = this;

    // Run request
    const response = await client.listVoices(request);
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
}

export default GoogleHelper;
