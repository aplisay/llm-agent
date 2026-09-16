import PipecatModel, {
  PIPECAT_PIPELINE_MODEL_IDS,
  isPipecatPipelineModelId,
  pipecatModelIdFlags,
  pipecatModelSupportsExternalTts,
} from '../lib/models/pipecat.js';
import {
  getTtsVendorsForAgentValidation,
  getVoiceNamesForAgentValidation,
  modelSupportsExternalTts,
  nativeTtsVendorForModel,
} from '../lib/model-voices.js';
import { XAI_DEFAULT_VOICE, XAI_FALLBACK_VOICES, XAI_VENDOR, xaiVoiceTree } from '../lib/voices/xai.js';
import { BUNDLED_TTS_PROVIDERS, TTS_ENGINES, buildRateComponents, isMinuteBilledModel } from '../lib/rate-components.js';
import {
  XAI_RESERVED_TOOL_NAMES,
  isXaiVoiceModelName,
  validateXaiVoiceAgent,
  xaiSessionOverrides,
} from '../lib/grok-limits.js';
import {
  DEFAULT_TEXT_MODELS,
  DEFAULT_VOICE_MODELS,
  bundledTtsLines,
  hasLine,
  priceFactorFor,
  round2sf,
  textPricesFor,
  ultravoxMinutePrice,
  xaiAdditions,
} from '../scripts/add-xai-rate-lines.mjs';

/**
 * xAI Grok on the server (docs/grok.md): the Pipecat roster rows and their
 * flags, the model-scoped xAI voice list, the minute-billed rate component,
 * the save-time rules for reserved tool names and vendorSpecific server
 * tools, and the rate-line script's planning against a fixture card. The
 * DB-backed save-time checks are tests/grok-validation.test.mjs; the driver
 * itself is tests/driver-upgrades.test.mjs.
 */

const GROK_VOICE = 'pipecat:xai/grok-voice-think-fast-2.0';

describe('Grok roster rows', () => {
  test('the voice row is realtime with no text-output mode', () => {
    expect(pipecatModelIdFlags['xai/grok-voice-think-fast-2.0']).toEqual({
      voiceStack: 'realtime', audioModel: true, pipeline: false,
    });
    expect(pipecatModelSupportsExternalTts('xai/grok-voice-think-fast-2.0')).toBe(false);
    expect(modelSupportsExternalTts(GROK_VOICE)).toBe(false);
    const row = PipecatModel.allModels.find(([id]) => id === 'xai/grok-voice-think-fast-2.0');
    expect(row[1]).toBe('xAI Grok Voice think-fast 2.0 (Pipecat)');
    expect(row[2].externalTts).toBeUndefined();
    expect(row[2].delegation).toBeUndefined();
  });

  test('the pipeline rows are grok-4.3 and grok-4.20-0309-non-reasoning', () => {
    for (const id of ['xai/grok-4.3', 'xai/grok-4.20-0309-non-reasoning']) {
      expect(isPipecatPipelineModelId(id)).toBe(true);
      expect(pipecatModelIdFlags[id]).toEqual({ voiceStack: 'pipeline', audioModel: false, pipeline: true });
      expect(PIPECAT_PIPELINE_MODEL_IDS).toContain(id);
    }
    expect(isPipecatPipelineModelId('xai/grok-voice-think-fast-2.0')).toBe(false);
    expect(isPipecatPipelineModelId('xai/grok-4.6')).toBe(false);
  });

  test('the native TTS vendor of a Grok row is xai', () => {
    expect(nativeTtsVendorForModel(GROK_VOICE)).toBe('xai');
  });

  test('isXaiVoiceModelName matches Grok voice rows on any handler and nothing else', () => {
    expect(isXaiVoiceModelName(GROK_VOICE)).toBe(true);
    expect(isXaiVoiceModelName('livekit:xai/grok-voice-think-fast-2.0')).toBe(true);
    expect(isXaiVoiceModelName('pipecat:xai/grok-4.3')).toBe(false);
    expect(isXaiVoiceModelName('text:xai/grok-4.6')).toBe(false);
    expect(isXaiVoiceModelName('pipecat:openai/gpt-realtime')).toBe(false);
    expect(isXaiVoiceModelName(undefined)).toBe(false);
  });
});

describe('Grok voices', () => {
  // The handler's merged catalogue: the xAI block beside the other vendors.
  const Handler = {
    voices: Promise.resolve({
      ...xaiVoiceTree(),
      OpenAI: { any: [{ name: 'alloy' }] },
      google: { any: [{ name: 'Kore' }] },
      ultravox: { any: [{ name: 'Mark' }] },
    }),
  };
  const voicesInstance = { listVoices: async () => ({ elevenlabs: { 'en-GB': [{ name: 'Rachel' }] } }) };

  test('the fallback list is the 26 documented voices with eve as the default', () => {
    expect(XAI_FALLBACK_VOICES.map((v) => v.name)).toEqual([
      'ara', 'eve', 'leo', 'rex', 'sal', 'carina', 'zagan', 'helix', 'orion', 'luna', 'iris', 'altair', 'zenith',
      'perseus', 'helios', 'lux', 'kepler', 'rigel', 'cosmo', 'celeste', 'ursa', 'sirius', 'lumen', 'castor', 'naksh', 'atlas',
    ]);
    expect(XAI_DEFAULT_VOICE).toBe('eve');
    expect(XAI_VENDOR).toBe('xAI');
    for (const v of XAI_FALLBACK_VOICES) {
      expect(['male', 'female']).toContain(v.gender);
      expect(v.description).toContain('multilingual');
    }
    expect(Object.keys(xaiVoiceTree())).toEqual(['xAI']);
    expect(Object.keys(xaiVoiceTree().xAI)).toEqual(['any']);
  });

  test('a Grok voice row validates voices against the xAI block only', async () => {
    const names = await getVoiceNamesForAgentValidation({ modelName: GROK_VOICE, Handler, voicesInstance });
    expect(names.has('eve')).toBe(true);
    expect(names.has('rex')).toBe(true);
    expect(names.has('alloy')).toBe(false);
    expect(names.has('Kore')).toBe(false);
    expect(names.has('Mark')).toBe(false);
    expect(names.has('Rachel')).toBe(false);
  });

  test('the other realtime rows never see the xAI block', async () => {
    const openai = await getVoiceNamesForAgentValidation({ modelName: 'pipecat:openai/gpt-realtime', Handler, voicesInstance });
    expect(openai.has('alloy')).toBe(true);
    expect(openai.has('eve')).toBe(false);
    const ultravox = await getVoiceNamesForAgentValidation({ modelName: 'livekit:ultravox/ultravox-v0.7', Handler, voicesInstance });
    expect(ultravox.has('Mark')).toBe(true);
    expect(ultravox.has('eve')).toBe(false);
  });

  test('the only TTS vendor a Grok voice row accepts is xai', async () => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName: GROK_VOICE, Handler, voicesInstance });
    expect([...vendors]).toEqual(['xai']);
  });
});

describe('Grok billing', () => {
  test('the voice row is minute-billed; the text and pipeline rows are token-billed', () => {
    expect(isMinuteBilledModel(GROK_VOICE)).toBe(true);
    expect(isMinuteBilledModel('livekit:xai/grok-voice-think-fast-2.0')).toBe(true);
    expect(isMinuteBilledModel('text:xai/grok-4.6')).toBe(false);
    expect(isMinuteBilledModel('pipecat:xai/grok-4.3')).toBe(false);
  });

  test('the rate-component catalogue prices the voice row per minute and the text rows per token', () => {
    const comps = buildRateComponents({
      implementations: [{ name: 'pipecat', description: 'Pipecat', hasWebRTC: true, hasTelephony: true }],
      models: [
        { name: GROK_VOICE, description: 'xAI Grok Voice think-fast 2.0 (Pipecat)' },
        { name: 'text:xai/grok-4.3', description: 'xAI Grok 4.3' },
      ],
    });
    const voice = comps.find((c) => c.key === `model:${GROK_VOICE}`);
    expect(voice.units).toEqual(['minute']);
    expect(voice.match).toEqual({ technology: 'voice', detail: GROK_VOICE });
    const text = comps.find((c) => c.key === 'model:text:xai/grok-4.3');
    expect(text.units).toEqual(['token']);
    expect(text.match).toEqual({ technology: 'llm', provider: 'xai', detail: 'xai/grok-4.3', unit: 'output_tokens' });
  });
});

describe('Grok save-time rules', () => {
  const fn = (name) => ({ name, implementation: 'rest', url: 'https://example.com', input_schema: { properties: {} } });

  test('reserved function names are rejected on a Grok voice row only', () => {
    expect(XAI_RESERVED_TOOL_NAMES.has('web_search')).toBe(true);
    expect(XAI_RESERVED_TOOL_NAMES.size).toBe(8);
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, functions: [fn('get_slots'), fn('web_search')] }))
      .toThrow(/"web_search" reserved by xAI/);
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, functions: { file_search: fn('file_search'), x: fn('x_user_search') } }))
      .toThrow(/"file_search", "x_user_search"/);
    // the key names the function when the entry has no name
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, functions: { browse_page: { implementation: 'rest' } } }))
      .toThrow(/"browse_page"/);
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, functions: [fn('get_slots'), fn('search_web')] })).not.toThrow();
    expect(() => validateXaiVoiceAgent({ modelName: 'pipecat:openai/gpt-realtime', functions: [fn('web_search')] })).not.toThrow();
    expect(() => validateXaiVoiceAgent({ modelName: 'text:xai/grok-4.3', functions: [fn('web_search')] })).not.toThrow();
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE })).not.toThrow();
  });

  test('vendorSpecific.xai.session may tune the session but not add server tools', () => {
    const ok = { vendorSpecific: { xai: { session: {
      turn_detection: { type: 'server_vad', silence_duration_ms: 350, idle_timeout_ms: 30000 },
      audio: { output: { speed: 1.1 } },
      replace: { Aplisay: 'Appli-say' },
      voice: 'custom_voice_1',
    } } } };
    expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, options: ok })).not.toThrow();
    expect(xaiSessionOverrides(ok)).toEqual(ok.vendorSpecific.xai.session);
    expect(xaiSessionOverrides({ vendorSpecific: { ultravox: {} } })).toBeNull();
    expect(xaiSessionOverrides({ vendorSpecific: { xai: { session: [] } } })).toBeNull();
    expect(xaiSessionOverrides(undefined)).toBeNull();
    for (const tools of [[], [{ type: 'function', name: 'x' }], null]) {
      expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, options: { vendorSpecific: { xai: { session: { tools } } } } }))
        .toThrow(/vendorSpecific\.xai\.session\.tools is not accepted/);
    }
    for (const type of ['mcp', 'web_search', 'x_search', 'file_search']) {
      const smuggled = { vendorSpecific: { xai: { session: { extras: [{ type }] } } } };
      expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, options: smuggled })).toThrow(new RegExp(`type "${type}"`));
      const single = { vendorSpecific: { xai: { session: { tool: { type } } } } };
      expect(() => validateXaiVoiceAgent({ modelName: GROK_VOICE, options: single })).toThrow(/server-side tool/);
    }
    // another row ignores the block entirely
    expect(() => validateXaiVoiceAgent({ modelName: 'pipecat:openai/gpt-realtime', options: { vendorSpecific: { xai: { session: { tools: [] } } } } }))
      .not.toThrow();
  });
});

describe('add-xai-rate-lines planning', () => {
  const ultravoxLine = (detail, priceMicros) => ({ dim: 'model', match: { technology: 'voice', detail }, unit: 'minute', priceMicros });
  const card = [
    { dim: 'audio-path', match: { technology: 'voice', provider: 'pipecat', media: 'webrtc' }, unit: 'minute', priceMicros: 500000 },
    ultravoxLine('livekit:ultravox/ultravox-v0.6', 6000000),
    ultravoxLine('pipecat:ultravox/ultravox-v0.7', 5500000),
    { dim: 'model', match: { technology: 'llm', provider: 'anthropic', detail: 'claude-sonnet-5', unit: 'input_tokens' }, unit: 'token', priceMicros: 3 },
  ];

  test('the voice price is the card\'s Ultravox minute line, preferring the same handler', () => {
    expect(ultravoxMinutePrice(card, 'pipecat:xai/grok-voice-think-fast-2.0')).toBe(5500000);
    expect(ultravoxMinutePrice(card, 'livekit:xai/grok-voice-think-fast-2.0')).toBe(6000000);
    expect(ultravoxMinutePrice([card[1]], 'pipecat:xai/grok-voice-think-fast-2.0')).toBe(6000000);
    expect(ultravoxMinutePrice([card[0], card[3]], 'pipecat:xai/grok-voice-think-fast-2.0')).toBeUndefined();
    expect(ultravoxMinutePrice([], 'pipecat:xai/grok-voice-think-fast-2.0')).toBeUndefined();
  });

  test('text prices follow the list table by the Sonnet 5 convention, with env overrides', () => {
    expect(textPricesFor('grok-4.6', {})).toEqual({ input: 2, output: 6, cacheRead: 0.5 });
    expect(textPricesFor('grok-4.3', {})).toEqual({ input: 1.25, output: 2.5, cacheRead: 0.2 });
    expect(textPricesFor('grok-4.20-0309-non-reasoning', {})).toEqual({ input: 1.25, output: 2.5, cacheRead: 0.2 });
    expect(textPricesFor('grok-4.6', { XAI_INPUT_PRICE_MICROS: '4', XAI_OUTPUT_PRICE_MICROS: '12' }))
      .toEqual({ input: 4, output: 12, cacheRead: 0.5 });
  });

  test('a card\'s own factor scales the list digits, rounded to two significant figures', () => {
    // The staging cards price Sonnet 5 input at 2.2 micro-pence: 0.7333 of its $3 list.
    const staging = [{ dim: 'model', match: { technology: 'llm', provider: 'anthropic', detail: 'claude-sonnet-5', unit: 'input_tokens' }, unit: 'token', priceMicros: 2.2 }];
    expect(priceFactorFor(staging, {})).toBe(0.7333);
    expect(textPricesFor('grok-4.6', {}, 0.7333)).toEqual({ input: 1.5, output: 4.4, cacheRead: 0.37 });
    expect(textPricesFor('grok-4.3', {}, 0.7333)).toEqual({ input: 0.92, output: 1.8, cacheRead: 0.15 });
    // an explicit override still wins over the factor
    expect(textPricesFor('grok-4.6', { XAI_OUTPUT_PRICE_MICROS: '5' }, 0.7333).output).toBe(5);
    // no reference line and no override: the raw list digits
    expect(priceFactorFor(card, {})).toBe(1);
    expect(priceFactorFor([], { XAI_PRICE_FACTOR: '0.5' })).toBe(0.5);
    expect(round2sf(1.4667)).toBe(1.5);
    expect(round2sf(0.14667)).toBe(0.15);
    expect(round2sf(0)).toBe(0);
    const additions = xaiAdditions(staging, { voiceModels: [], factor: priceFactorFor(staging, {}), env: {} });
    expect(additions.find((l) => l.match.detail === 'xai/grok-4.6' && l.match.unit === 'output_tokens').priceMicros).toBe(4.4);
  });

  test('the voice model\'s own speech is a bundled tts provider a card can zero-price', () => {
    expect(BUNDLED_TTS_PROVIDERS).toContain('xai');
    expect(TTS_ENGINES).not.toContain('xai');
  });

  test('the additions are one minute line per voice row, a zero speech pair per bundled provider and three token lines per text model, minus what is present', () => {
    const additions = xaiAdditions(card, { voicePrice: 5500000, env: {} });
    expect(additions).toHaveLength(DEFAULT_VOICE_MODELS.length + BUNDLED_TTS_PROVIDERS.length * 2 + DEFAULT_TEXT_MODELS.length * 3);
    expect(additions[0]).toEqual({
      dim: 'model', match: { technology: 'voice', detail: 'pipecat:xai/grok-voice-think-fast-2.0' }, unit: 'minute', priceMicros: 5500000,
    });
    // the worker meters a realtime model's own speech under the model's
    // vendor for all three, so all three get their zero pair here, in the
    // shape the cards already carry for ultravox (the row unit inside the match)
    const pair = (provider) => [
      { dim: 'tts', match: { technology: 'tts', provider, unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 },
      { dim: 'tts', match: { technology: 'tts', provider, unit: 'characters' }, unit: 'character', priceMicros: 0 },
    ];
    expect(additions.filter((l) => l.dim === 'tts')).toEqual([...pair('ultravox'), ...pair('openai'), ...pair('xai')]);
    expect(bundledTtsLines(['ultravox'])).toEqual(pair('ultravox'));
    // the zero lines are seeded even on a run that skips the voice rows
    expect(xaiAdditions(card, { voiceModels: [], env: {} }).filter((l) => l.dim === 'tts')).toHaveLength(6);
    // a card that already carries the ultravox pair keeps it (the staging cards do)
    const withUltravox = [...card, ...pair('ultravox')];
    expect(xaiAdditions(withUltravox, { voicePrice: 5500000, env: {} }).filter((l) => l.dim === 'tts').map((l) => l.match.provider))
      .toEqual(['openai', 'openai', 'xai', 'xai']);
    const units = additions.filter((l) => l.match.detail === 'xai/grok-4.6').map((l) => [l.match.unit, l.priceMicros]);
    expect(units).toEqual([['input_tokens', 2], ['output_tokens', 6], ['cache_read_tokens', 0.5]]);
    expect(additions.every((l) => l.match.technology === 'voice'
      || (l.dim === 'tts' && l.priceMicros === 0)
      || l.match.provider === 'xai')).toBe(true);
    // idempotent: a second run over the seeded card adds nothing
    const seeded = [...card, ...additions];
    expect(xaiAdditions(seeded, { voicePrice: 5500000, env: {} })).toEqual([]);
    expect(hasLine(seeded, additions[0])).toBe(true);
    expect(hasLine(card, additions[0])).toBe(false);
    // a narrower run still respects what is there
    const narrow = xaiAdditions(seeded, { textModels: ['grok-4.5'], voiceModels: [], env: {} });
    expect(narrow.map((l) => l.match.detail)).toEqual(['xai/grok-4.5', 'xai/grok-4.5', 'xai/grok-4.5']);
  });
});
