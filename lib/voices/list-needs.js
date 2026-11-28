import { googleCredentialsConfigured } from '../google-credential.js';

/**
 * The settings this server needs before it asks a vendor for its voice list.
 * With one unset the vendor is not asked at all, and its voices are absent
 * from every list. GET /api/health names the same settings as missing
 * (lib/config-status.js; tests/config-status.test.mjs keeps the two in step).
 *
 * xAI is not here: with no key its built-in list is used (lib/voices/xai.js).
 */
export const VOICE_LIST_NEEDS = {
  ultravox: ['ULTRAVOX_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY'],
  cartesia: ['CARTESIA_API_KEY'],
  neuphonic: ['NEUPHONIC_API_KEY'],
  google: ['GOOGLE_APPLICATION_CREDENTIALS'],
};

/**
 * @param {string} vendor a key of VOICE_LIST_NEEDS
 * @returns {string[]} the settings still to be set. Empty: the vendor may be asked.
 */
export function voiceListMissing(vendor, env = process.env) {
  if (vendor === 'google' && googleCredentialsConfigured(env)) return [];
  return (VOICE_LIST_NEEDS[vendor] || []).filter((name) => !env[name]);
}
