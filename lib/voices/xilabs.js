import speak from '../utils/speak.js';

import fetch from 'node-fetch';
import { catalogueCache } from './catalogue-cache.js';


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

export const getAccent = (name) => {
  let [accent, language] = Object.entries(accentMap).find(([a,]) => a.startsWith(name.toLowerCase())) || ['', accentMap['default']];
  return { language, decorator: accent.slice(name.length).replace(/^-+/, '')};
};

const URI = 'https://api.elevenlabs.io/v1/voices';

/** ElevenLabs voices as catalogue rows. Uncached; see xilabsCatalogue. */
export async function loadXiLabsVoices({ logger }) {
  const response = await fetch(URI, {
    method: 'GET',
    headers: {
      "Accept": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(10000),
  }).then(res => res.json());
  logger.debug({ response }, 'Xilabs response');
  // An error body has no voices; failing keeps it out of the cache.
  if (!Array.isArray(response?.voices)) throw new Error(response?.detail?.message || 'no voices in response');
  return response.voices.map(voice => {
    let { name: d1, voice_id: name, labels: { gender, accent, age, description: d2 = "" } } = voice;
    let { language, decorator } = getAccent(accent);
    return { name, gender, description: `${d1} - ${decorator&&(decorator+" ")}${age} ${d2}`, language: language || accentMap.default };
  });
}

let loadLogger;
const xilabsCatalogue = catalogueCache({ name: 'elevenlabs', load: () => loadXiLabsVoices({ logger: loadLogger }) });

/** Forget the cached catalogue (tests). */
export const resetXiLabsVoicesCache = () => xilabsCatalogue.reset();

class XiLabs {
  static name = 'elevenlabs';
  static description = 'XiLabs TTS';

  constructor(logger) {
    Object.assign(this, {
      logger: logger.child({ deepgramHelper: true }),
      useSsml: true,
      speak: speak.ssml
    });
    loadLogger ||= logger;
  }

  /**
   *  Get all of the ElevenLabs TTS voices
   *
   * @return {Promise<Object[]>} All Jambonz number resources on the instance
   * @memberof GoogleHelper
   */
  async listVoices(languageCode) {
    let { logger} = this;
    let list;

    try {
      const list = await xilabsCatalogue.get({ logger });
      return list.filter(voice => (!languageCode || voice?.language?.startsWith(languageCode)))
        .reduce((o, v) => ({ ...o, [v.language]: [...(o[v.language] || []), { ...v, language: undefined }] }), {});
    } catch (err) {
      logger.error({ err, list }, 'Error listing voices');
      return {};
    }
  }

}

export default XiLabs;
