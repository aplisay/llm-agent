// Deepgram has a hardcoded list, no API discovery endpoint AFAIK.
//  This is scraped from https://developers.deepgram.com/docs/tts-models
//  using regexp replace /([A-Za-z]+)\sEnglish\(([A-Z]+)\)\s([A-Za-z]+)\s*([a-z]+) - ([a-z]+) - ([a-z]+)/['$1', 'en-$2', '$3', '$4-$5-$6'],/
const voices = [ 
  ['Amy', 'en-GB', 'Female', 'Amy'],
  ['Brian', 'en-GB', 'Male', 'Brian']
];


class Aws {
  constructor(logger) {
    this.logger = logger.child({ AwsHelper: true });

  }

  /**
   *  Get all of the TTS voices
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof GoogleHelper
   */
  async listVoices(languageCode) {
    let list = voices.reduce((o, [description, language, gender, name]) => {
      if (!languageCode || language.startsWith(languageCode)) {
        !o[language] && (o[language] = []);
        o[language].push({ name, description, gender: gender.toLowerCase() });
      }
      return o;
    }, {});
    return Promise.resolve(list);
  }

}

module.exports = Aws;