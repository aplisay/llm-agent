import speak from '../utils/speak.js';

// Deepgram has a hardcoded list, no API discovery endpoint AFAIK.
//  This is scraped from https://developers.deepgram.com/docs/tts-models
//  using regexp replace /([A-Za-z]+)\sEnglish\(([A-Z]+)\)\s([A-Za-z]+)\s*([a-z]+) - ([a-z]+) - ([a-z]+)/['$1', 'en-$2', '$3', '$4-$5-$6'],/
const voices = [
['Asteria', 'en-US', 'Female', 'aura-asteria-en'],	
['Luna', 'en-US', 'Female', 'aura-luna-en'],	
['Stella', 'en-US', 'Female', 'aura-stella-en'],	
['Athena', 'en-GB', 'Female', 'aura-athena-en'],	
['Hera', 'en-US', 'Female', 'aura-hera-en'],	
['Orion', 'en-US', 'Male', 'aura-orion-en'],	
['Arcas', 'en-US', 'Male', 'aura-arcas-en'],	
['Perseus', 'en-US', 'Male', 'aura-perseus-en'],	
['Angus', 'en-IE', 'Male', 'aura-angus-en'],	
['Orpheus', 'en-US', 'Male', 'aura-orpheus-en'],	
['Helios', 'en-GB', 'Male', 'aura-helios-en'],	
['Zeus', 'en-US', 'Male', 'aura-zeus-en']
]


class Deepgram {



  constructor(logger) {
    this.logger = logger.child({ deepgramHelper: true });

  }

  get useSsml() {
    return false;
  }
  get speak() {
    return speak.text;
  }


  /**
   *  Get all of the Google TTS voices
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

export default Deepgram;