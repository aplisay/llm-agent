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
 * @typedef {{ name: string, description: string, gender?: string }} VoiceRow
 */

/** @type {VoiceRow[]} */
export const OPENAI_LIVE_VOICES = [
  { name: 'alloy', description: 'Alloy', gender: 'female' },
  { name: 'ash', description: 'Ash', gender: 'male' },
  { name: 'ballad', description: 'Ballad', gender: 'male' },
  { name: 'beacon', description: 'Beacon' },
  { name: 'bossa', description: 'Bossa' },
  { name: 'cedar', description: 'Cedar', gender: 'male' },
  { name: 'cinder', description: 'Cinder' },
  { name: 'coral', description: 'Coral', gender: 'female' },
  { name: 'delta', description: 'Delta' },
  { name: 'echo', description: 'Echo', gender: 'male' },
  { name: 'gleam', description: 'Gleam' },
  { name: 'marin', description: 'Marin (default)', gender: 'female' },
  { name: 'meridian', description: 'Meridian' },
  { name: 'quartz', description: 'Quartz' },
  { name: 'ripple', description: 'Ripple' },
  { name: 'sage', description: 'Sage', gender: 'female' },
  { name: 'shimmer', description: 'Shimmer', gender: 'female' },
  { name: 'stone', description: 'Stone' },
  { name: 'tempo', description: 'Tempo' },
  { name: 'verse', description: 'Verse', gender: 'male' },
  { name: 'vesper', description: 'Vesper' },
  { name: 'willow', description: 'Willow' },
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
