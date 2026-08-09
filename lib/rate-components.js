/**
 * The priceable-component catalogue (Phase 3) — the env-independent roster that
 * `/api/rate-components` advertises so the rate-card UI pre-creates correct lines.
 *
 * Built from in-tree constants (the handler registry + the metered TTS/STT
 * engines), NOT from live credentialed enumeration — every component is listed
 * regardless of which keys happen to be configured. Each component declares:
 *   - `dim`     the pricing dimension (audio-path | model | tts | stt);
 *   - `match`   the rate-line match TEMPLATE the row will carry (so a line keyed
 *               on it actually resolves — see lib/rates.js resolveRowCost);
 *   - `units`   the billing unit(s) the vendor actually bills on (the UI only
 *               offers a basis that has a live meter).
 *
 * The model dimension is PER-MODEL: a minute-billed managed realtime bundle
 * (Ultravox) is priced on its `voice` row's `detail`; every other model bills per
 * token on its `llm` rows. (A future model billed on BOTH is expressible — emit
 * two components; the schema/UI must not preclude it.)
 *
 * @module lib/rate-components
 */

/** TTS engines and the billing units each can be metered on (characters + audio ms). */
export const TTS_ENGINES = ['elevenlabs', 'cartesia', 'deepgram', 'google'];
/** STT engines and their metered billing units (audio ms + transcript characters). */
export const STT_ENGINES = ['deepgram'];

/** Split `<handler>:<vendor>/<model>` into its parts; `detail` is the post-handler id. */
function parseModelName(name) {
  const colon = name.indexOf(':');
  const detail = colon >= 0 ? name.slice(colon + 1) : name;
  const slash = detail.indexOf('/');
  const vendor = slash >= 0 ? detail.slice(0, slash) : detail;
  return { vendor, detail };
}

/** A managed realtime bundle (Ultravox) bills per minute on its voice row, not tokens. */
function isMinuteBilledModel(name) {
  return /ultravox/i.test(name || '');
}

/**
 * Build the priceable-component catalogue.
 *
 * @param {object} opts
 * @param {Array}  opts.implementations handler classes ({ name, description, hasWebRTC, hasTelephony })
 * @param {Array}  opts.models          roster from handlers().models ({ name, description })
 * @returns {Array<object>} components
 */
export function buildRateComponents({ implementations = [], models = [] } = {}) {
  const components = [];

  // audio-path: handler × the media it transports (per minute).
  for (const h of implementations) {
    if (!h?.name || !(h.hasWebRTC || h.hasTelephony)) continue;
    const medias = [...(h.hasWebRTC ? ['webrtc'] : []), ...(h.hasTelephony ? ['telephony'] : [])];
    for (const media of medias) {
      components.push({
        dim: 'audio-path',
        key: `audio-path:${h.name}:${media}`,
        label: `${h.description || h.name} · ${media}`,
        match: { technology: 'voice', provider: h.name, media },
        units: ['minute'],
        available: true,
      });
    }
  }
  // The blind-bridge tail leg is a telephony passthrough priced by its sentinel.
  components.push({
    dim: 'audio-path',
    key: 'audio-path:bridged-call',
    label: 'Bridged telephony tail leg',
    match: { technology: 'voice', detail: 'telephony:bridged-call', media: 'telephony' },
    units: ['minute'],
    available: true,
  });

  // model: per roster model, classified by its real billing basis.
  for (const m of models) {
    if (!m?.name) continue;
    if (isMinuteBilledModel(m.name)) {
      components.push({
        dim: 'model',
        key: `model:${m.name}`,
        label: m.description || m.name,
        model: m.name,
        match: { technology: 'voice', detail: m.name },
        units: ['minute'],
        available: true,
      });
    } else {
      const { vendor, detail } = parseModelName(m.name);
      components.push({
        dim: 'model',
        key: `model:${m.name}`,
        label: m.description || m.name,
        model: m.name,
        match: { technology: 'llm', provider: vendor, detail, unit: 'output_tokens' },
        units: ['token'],
        available: true,
      });
    }
  }

  // tts / stt: per engine, the metered billing units (chars OR time, per engine).
  for (const provider of TTS_ENGINES) {
    components.push({
      dim: 'tts', key: `tts:${provider}`, label: `TTS · ${provider}`,
      match: { technology: 'tts', provider }, units: ['character', 'minute'], available: true,
    });
  }
  for (const provider of STT_ENGINES) {
    components.push({
      dim: 'stt', key: `stt:${provider}`, label: `STT · ${provider}`,
      match: { technology: 'stt', provider }, units: ['minute', 'character'], available: true,
    });
  }

  return components;
}

export default buildRateComponents;
