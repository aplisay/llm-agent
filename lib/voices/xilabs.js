const options = {
  method: 'GET',
  headers: {
    "Accept": "application/json",
    "xi-api-key": process.env.ELEVENLABS_API_KEY,
    "Content-Type": "application/json"
  }
};

// XiLabs only tag languages as accents like 'british', 'american', or even 'british-swedish'
//  we do our best with this idiom by mapping the primary accent 
const accentMap = {
  american: 'en-US',
  british: 'en-GB',
  english: 'en-GB',
  australian: 'en-AU',
  irish: 'en-IE',
  default: 'en-US'
}

const getAccent = (name) => {
  let [accent, language] = Object.entries(accentMap).find(([a,]) => a.startsWith(name)) || ['', accentMap['default']];
  return { language, decorator: accent.replace(new RegExp(`${name}\-*`), '')};
};

const URI = 'https://api.elevenlabs.io/v1/voices';

class XiLabs {
  constructor(logger) {
    this.logger = logger.child({ deepgramHelper: true });
    this.list = new Promise((resolve, reject) => {
      fetch(URI, options)
        .then(response => response.json())
       .then(response => 
         resolve(response?.voices?.map(voice => {
           let { name: d1, voice_id: name, labels: { gender, accent, age, description: d2 = "" } } = voice;
           let { language, decorator } = getAccent(accent);
           return { name, gender, description: `${d1} - ${decorator&&(decorator+" ")}${age} ${d2}`, language: (accentMap[accent] || accentMap.default) };
          }))
        )
        .catch(err => reject(err));
      })
    
  }
  

  /**
   *  Get all of the ElevenLabs TTS voices
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof GoogleHelper
   */
  async listVoices(languageCode) {
    return (await this.list).filter(voice => (!languageCode || voice?.language?.startsWith(languageCode)))
      .reduce((o, v) => ({ ...o, [v.language]: [...(o[v.language] || []), { ...v, language: undefined }] }), {});
  }

}

module.exports = XiLabs;