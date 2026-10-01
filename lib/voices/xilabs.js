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

/**
 * One catalogue row per ElevenLabs voice. `name` is the voice id; the
 * description is the voice's own name followed by whichever labels it has.
 * Any label can be missing (a cloned voice may have no age), and the API now
 * calls the free-text label `descriptive`.
 *
 * @param {object[]} voices `voices` from the GET /v1/voices body
 * @returns {{ name: string, gender?: string, description: string, language: string }[]}
 */
export function mapXiLabsVoices(voices) {
  return voices.map(voice => {
    const labels = voice.labels || {};
    const { language, decorator } = labels.accent ? getAccent(labels.accent) : { language: '', decorator: '' };
    const details = [decorator, labels.age, labels.descriptive ?? labels.description]
      .filter(Boolean).join(' ').replace(/_/g, ' ');
    return {
      name: voice.voice_id,
      gender: labels.gender,
      description: details ? `${voice.name} - ${details}` : voice.name,
      language: language || accentMap.default,
    };
  });
}

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
  return mapXiLabsVoices(response.voices);
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
