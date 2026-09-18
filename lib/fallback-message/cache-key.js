/**
 * Cache-key derivation for synthesised fallback messages.
 *
 * The fixed-message failover path (`options.fallback.message`) plays a
 * pre-synthesised announcement at the caller when agent setup has failed. The
 * audio never varies for a given configuration, so it is synthesised once and
 * cached in GCS; every later playout is a byte-for-byte replay.
 *
 * The cache is **content-addressed**: the object name is a digest of exactly
 * those inputs that change the audio. Two consequences follow, and both are
 * deliberate:
 *
 *   - Editing the message text (or the voice, vendor, or language) yields a
 *     different key, so the next playout misses, re-synthesises, and writes a
 *     new object. Invalidation is therefore automatic — there is no cache to
 *     explicitly bust and no way to serve stale audio for edited text.
 *   - Two agents configured with the same announcement in the same voice share
 *     one object. That is a dedupe win rather than a leak: the object's content
 *     is fully determined by the key, so a reader who can compute the key
 *     already holds the plaintext that produced it, and the bucket itself is
 *     platform-private (workers read it with platform credentials; it is never
 *     exposed to tenants).
 *
 * Mirrored by `agents/pipecat/pipecat_aplisay/fallback_message/cache_key.py`.
 * The digest formula is a cross-runtime contract: a change on one side that is
 * not made on the other silently splits the cache in two (correct audio, wasted
 * synthesis). See CONTRACT.md.
 */

import { createHash } from 'node:crypto';

/** Digest length in hex characters. 32 hex chars = 128 bits, ample for a CAS. */
export const KEY_LENGTH = 32;

/**
 * @typedef {Object} ResolvedFallbackMessage
 * @property {string} text The words to speak.
 * @property {string=} vendor TTS provider, e.g. `elevenlabs` or `deepgram/aura-2`.
 * @property {string=} voice Voice specifier as understood by `vendor`.
 * @property {string=} language BCP-47 language tag.
 */

/**
 * Resolve `options.fallback.message` against the agent's own `options.tts`.
 *
 * The message may name its own vendor/voice/language — the point of the feature
 * is that the announcement can be spoken by a TTS that is known-good even when
 * the agent's configured stack is what just failed. Anything the message does
 * not state falls back to the agent's normal TTS settings, so the common case
 * ("say this, in my usual voice") needs only `text`.
 *
 * `inheritAgentTts` is the exception, and it matters: a realtime
 * speech-to-speech agent (Ultravox, OpenAI Realtime, Gemini Live) has no
 * discrete TTS, and its `options.tts.voice` names a timbre of the *model*.
 * The announcement is always spoken by a real TTS — it plays because the model
 * could not be started, so the model cannot be what speaks it — and handing a
 * TTS service a vendor of `ultravox` does not degrade, it throws. So for those
 * agents the vendor and voice are NOT inherited, leaving the worker to use its
 * default TTS unless the message names one explicitly.
 *
 * `language` is inherited either way: it is a portable BCP-47 tag that means
 * the same thing to a model and to a TTS, and an announcement in the wrong
 * language would be worse than one in an unfamiliar voice.
 *
 * @param {unknown} message Raw `options.fallback.message`. Must be an object
 *   with `text`; a bare string is not accepted (see below).
 * @param {{ tts?: { vendor?: string, voice?: string, language?: string } }=} agentOptions
 * @param {{ inheritAgentTts?: boolean }=} opts `inheritAgentTts` defaults to
 *   true (a pipeline agent, whose `options.tts` describes a real TTS). Pass
 *   false for a realtime agent. Callers must agree on this: it feeds the cache
 *   key, so the two runtimes deciding differently would split the cache.
 * @returns {ResolvedFallbackMessage | null} `null` when no usable text is configured.
 */
export function resolveFallbackMessage(message, agentOptions = {}, { inheritAgentTts = true } = {}) {
  // Deliberately NOT accepting a bare string as shorthand for `{ text }`. The
  // option always takes an object, so there is one shape to document, one to
  // validate, and one to read — worth a few extra characters in the common
  // case. Anything else resolves to null here, but the write-time validation in
  // lib/database.js rejects it outright, so a bad shape is a save error rather
  // than an announcement that silently never plays.
  const raw = message;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) {
    return null;
  }
  const tts = agentOptions?.tts || {};
  const pick = (a, b) => {
    const v = typeof a === 'string' && a.trim() ? a : b;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  return {
    text,
    vendor: pick(raw.vendor, inheritAgentTts ? tts.vendor : undefined),
    voice: pick(raw.voice, inheritAgentTts ? tts.voice : undefined),
    // Always inherited — a language tag is portable across model and TTS.
    language: pick(raw.language, tts.language),
  };
}

/**
 * Derive the content-addressed cache key for a resolved message.
 *
 * Fields are hashed as a canonical JSON array rather than a concatenated string
 * so that a value containing the separator cannot collide with a different
 * field split (`{voice: 'a|b'}` vs `{voice: 'a', language: 'b'}`).
 *
 * @param {ResolvedFallbackMessage} resolved Output of {@link resolveFallbackMessage}.
 * @returns {string} Lowercase hex digest, {@link KEY_LENGTH} characters.
 */
export function fallbackMessageKey(resolved) {
  if (!resolved?.text) {
    throw new Error('fallbackMessageKey: resolved message must have text');
  }
  const canonical = JSON.stringify([
    resolved.text,
    resolved.vendor || '',
    resolved.voice || '',
    resolved.language || '',
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, KEY_LENGTH);
}
