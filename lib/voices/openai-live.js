/**
 * The OpenAI GPT-Live voice catalogue (docs/gpt-live.md).
 *
 * GPT-Live (`gpt-live-1`) accepts a different voice list from OpenAI Realtime,
 * so the `OpenAI` block a GPT-Live row offers is this one rather than the
 * Realtime list in lib/handlers/pipecat.js. Voices are locale-neutral: the
 * model speaks the language of the conversation, the voice picks the timbre,
 * so the block is keyed under the `any` locale like the other realtime
 * catalogues. Names are the values the Live API takes in
 * `session.audio.output.voice`; the default is what the API applies when none
 * is sent.
 *
 * Not a lib/voices catalogue service (those enumerate discrete TTS engines):
 * this is a static list consumed by lib/model-voices.js for the GPT-Live rows.
 */

export const OPENAI_LIVE_DEFAULT_VOICE = 'marin';

/** Vendor key the block is published under, matching the Realtime block. */
export const OPENAI_LIVE_VENDOR = 'OpenAI';

/**
 * @typedef {{ name: string, description: string, gender: 'male' | 'female' }} VoiceRow
 */

/**
 * Each description names the voice's presentation and accent. Every GPT-Live
 * voice sits under the `any` locale, and the list_voices search
 * (lib/model-voices.js) matches only name, description, gender and locale, so
 * the description is the only place an accent can be found. The accents of the
 * twelve voices added with GPT-Live follow OpenAI's descriptions. OpenAI gives
 * no accent for the other ten, and their gender is Aplisay's label.
 *
 * Vesper is the British English voice. Stone and Willow are Irish English and
 * are described as "more British (UK)". All three say "British (UK)", so a
 * search for "british", "brit" or "uk" finds them. The two Southern US voices
 * say "US (American, USA)", so each of those words finds them. No description
 * names another accent to compare with: "than US voices" would make a "us"
 * search find the Irish voices.
 *
 * @type {VoiceRow[]}
 */
export const OPENAI_LIVE_VOICES = [
  { name: 'alloy', description: 'Female-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'female' },
  { name: 'ash', description: 'Male-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'male' },
  { name: 'ballad', description: 'Male-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'male' },
  { name: 'beacon', description: 'Masculine presentation with Filipino English influence.', gender: 'male' },
  { name: 'bossa', description: 'Feminine presentation with Brazilian Portuguese influence.', gender: 'female' },
  { name: 'cedar', description: 'Male-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'male' },
  { name: 'cinder', description: 'Masculine presentation with Southern US (American, USA) English influence.', gender: 'male' },
  { name: 'coral', description: 'Female-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'female' },
  { name: 'delta', description: 'Feminine presentation with Southern US (American, USA) English influence.', gender: 'female' },
  { name: 'echo', description: 'Male-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'male' },
  { name: 'gleam', description: 'Feminine presentation with North American English influence.', gender: 'female' },
  { name: 'marin', description: "GPT-Live's default voice, female-labelled by Aplisay, with no regional accent specified by OpenAI.", gender: 'female' },
  { name: 'meridian', description: 'Masculine presentation with North American English influence.', gender: 'male' },
  { name: 'quartz', description: 'Feminine presentation with Australian English influence.', gender: 'female' },
  { name: 'ripple', description: 'Masculine presentation with Australian English influence.', gender: 'male' },
  { name: 'sage', description: 'Female-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'female' },
  { name: 'shimmer', description: 'Female-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'female' },
  { name: 'stone', description: 'Masculine presentation with Irish English influence; more British (UK).', gender: 'male' },
  { name: 'tempo', description: 'Masculine presentation with Brazilian Portuguese influence.', gender: 'male' },
  { name: 'verse', description: 'Male-labelled by Aplisay, with no regional accent specified by OpenAI.', gender: 'male' },
  { name: 'vesper', description: 'Masculine presentation with British (UK) English influence.', gender: 'male' },
  { name: 'willow', description: 'Feminine presentation with Irish English influence; more British (UK).', gender: 'female' },
];

/**
 * The GPT-Live block in the `vendor → locale → voices[]` shape the model voice
 * helpers consume. A fresh copy each call so callers may mutate it.
 *
 * @returns {Record<string, Record<string, VoiceRow[]>>}
 */
export function openaiLiveVoiceTree() {
  return { [OPENAI_LIVE_VENDOR]: { any: OPENAI_LIVE_VOICES.map((v) => ({ ...v })) } };
}

export default OPENAI_LIVE_VOICES;
