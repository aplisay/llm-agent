import { setupRealDatabase, teardownRealDatabase, databaseStarted } from './setup/database-test-wrapper.js';
import { buildRateComponents, TTS_ENGINES } from '../lib/rate-components.js';
import { resolveRowCost } from '../lib/rates.js';

// Phase-3 catalogue: the priceable-component roster /api/rate-components advertises,
// and a check that its match templates actually resolve through the Phase-2 engine
// (so the UI pre-creates lines that really price rows). buildRateComponents +
// resolveRowCost are pure; the DB lifecycle is only here because importing
// lib/rates.js initialises the shared database module.

beforeAll(async () => { await setupRealDatabase(); await databaseStarted; }, 30000);
afterAll(async () => { await teardownRealDatabase(); }, 30000);

const implementations = [
  { name: 'livekit', description: 'Livekit', hasWebRTC: true, hasTelephony: true },
  { name: 'jambonz', description: 'Jambonz', hasWebRTC: false, hasTelephony: true },
  { name: 'text', description: 'Text', hasWebRTC: false, hasTelephony: false }, // omitted (no transport)
];
const models = [
  { name: 'livekit:ultravox/ultravox-v0.6', description: 'Ultravox' },
  { name: 'livekit:openai/gpt-4o', description: 'GPT-4o' },
];

describe('rate-components catalogue', () => {
  const comps = buildRateComponents({ implementations, models });
  const byKey = (k) => comps.find((c) => c.key === k);

  it('audio-path = handler × media; transport-less handler omitted; bridged sentinel present', () => {
    expect(byKey('audio-path:livekit:webrtc').match).toEqual({ technology: 'voice', provider: 'livekit', media: 'webrtc' });
    expect(byKey('audio-path:livekit:telephony')).toBeTruthy();
    expect(byKey('audio-path:jambonz:webrtc')).toBeUndefined(); // jambonz has no webrtc
    expect(byKey('audio-path:jambonz:telephony')).toBeTruthy();
    expect(byKey('audio-path:bridged-call')).toBeTruthy();
    expect(comps.some((c) => c.label === 'Text')).toBe(false);
  });

  it('Ultravox model is minute-billed on the voice detail; others token-billed on llm rows', () => {
    const uv = byKey('model:livekit:ultravox/ultravox-v0.6');
    expect(uv.units).toEqual(['minute']);
    expect(uv.match).toEqual({ technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' });
    const gpt = byKey('model:livekit:openai/gpt-4o');
    expect(gpt.units).toEqual(['token']);
    expect(gpt.match).toEqual({ technology: 'llm', provider: 'openai', detail: 'openai/gpt-4o', unit: 'output_tokens' });
  });

  it('advertises tts/stt engines with their billing units', () => {
    expect(comps.filter((c) => c.dim === 'tts').map((c) => c.match.provider).sort()).toEqual([...TTS_ENGINES].sort());
    expect(byKey('tts:elevenlabs').units).toEqual(['character', 'minute']);
    expect(byKey('stt:deepgram').units).toEqual(['minute', 'character']);
  });

  it('the catalogue match templates resolve a real Ultravox voice row on BOTH dimensions', () => {
    const line = (comp, priceMicros) => ({ dim: comp.dim, match: comp.match, unit: 'minute', priceMicros });
    const card = { detail: { lines: [
      line(byKey('audio-path:livekit:webrtc'), 500000),
      line(byKey('model:livekit:ultravox/ultravox-v0.6'), 6000000),
    ] } };
    const row = { technology: 'voice', provider: 'livekit', detail: 'livekit:ultravox/ultravox-v0.6', unit: 'milliseconds', media: 'webrtc', quantity: 60000 };
    const { costMicros, breakdown } = resolveRowCost(row, card);
    expect(costMicros).toBe(6500000);
    expect(breakdown.map((b) => b.dim).sort()).toEqual(['audio-path', 'model']);
  });
});
