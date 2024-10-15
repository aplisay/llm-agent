const speak = require("../utils/speak");

// Imports the Google Cloud client library
const textToSpeech = require("@google-cloud/text-to-speech").v1;

// Import other required libraries
const fs = require("fs");
const util = require("util");

/**
 *
 *
 * @class GoogleHelper
 */
class GoogleHelper {
  constructor(logger) {
    this.logger = logger.child({ googleHelper: true });
    this.client = new textToSpeech.TextToSpeechClient();
  }

  get useSsml() {
    return true;
  }
  get speak() {
    this.logger.info({ speak, ssml: speak.ssml }, "speak values");
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

module.exports = GoogleHelper;
