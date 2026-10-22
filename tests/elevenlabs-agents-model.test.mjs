import PipecatModel, {
  pipecatModelIdFlags,
  pipecatModelSupportsDelegation,
  pipecatModelSupportsExternalTts,
  isPipecatPipelineModelId,
} from '../lib/models/pipecat.js';
import {
  getTtsVendorsForAgentValidation,
  getVoiceNamesForAgentValidation,
  isExternalTtsForModel,
  modelSupportsExternalTts,
  nativeTtsVendorForModel,
} from '../lib/model-voices.js';
import {
  ELEVENLABS_AGENT_LLMS,
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_PROTECTED_CONFIG_PATHS,
  ELEVENLABS_RESERVED_TOOL_NAMES,
  elevenLabsAgentRows,
  elevenLabsVendorBlock,
  isElevenLabsAgentsModelName,
  validateElevenLabsAgent,
} from '../lib/elevenlabs-agents.js';
import { BUNDLED_TTS_PROVIDERS, buildRateComponents, isMinuteBilledModel } from '../lib/rate-components.js';
import { groupByLocale, mapXiLabsVoices, xilabsVoiceTree, seedXiLabsVoices, resetXiLabsVoicesCache } from '../lib/voices/xilabs.js';
import { DEFAULT_VOICE_MODELS, elevenLabsAdditions } from '../scripts/add-elevenlabs-rate-lines.mjs';
import LivekitModel, { livekitModelIdFlags } from '../lib/models/livekit.js';

/**
 * ElevenLabs Agents rows without a database (docs/elevenlabs-agents.md): the
 * roster, the voice scoping, the save-time rules and the rate planning. The
 * save path and the voices endpoints are tests/elevenlabs-agents-validation.test.mjs;
 * the worker is agents/pipecat/tests/test_elevenlabs_agents.py.
 */

const ROW = 'pipecat:elevenlabs/gemini-2.5-flash';

const catalogue = mapXiLabsVoices([
  { voice_id: 'v-brit', name: 'Alice', labels: { accent: 'british', gender: 'female', age: 'young' } },
  { voice_id: 'v-us', name: 'Bob', labels: { accent: 'american', gender: 'male' } },
  { voice_id: ELEVENLABS_DEFAULT_VOICE, name: 'Chris', labels: { accent: 'american', gender: 'male' } },
]);

describe('ElevenLabs Agents roster rows', () => {
  test('one realtime row per LLM, with no text-output mode and no delegation', () => {
    const ids = ELEVENLABS_AGENT_LLMS.map(({ id }) => `elevenlabs/${id}`);
    expect(ids).toEqual([
      'elevenlabs/gemini-2.5-flash', 'elevenlabs/gpt-5.4-mini', 'elevenlabs/claude-haiku-5-5', 'elevenlabs/claude-sonnet-5-5',
    ]);
    for (const id of ids) {
      expect(pipecatModelIdFlags[id]).toEqual({ voiceStack: 'realtime', audioModel: true, pipeline: false });
      expect(pipecatModelSupportsExternalTts(id)).toBe(false);
      expect(pipecatModelSupportsDelegation(id)).toBe(false);
      expect(isPipecatPipelineModelId(id)).toBe(false);
      const row = PipecatModel.allModels.find(([rowId]) => rowId === id);
      expect(row[1]).toMatch(/^ElevenLabs Agents, .* \(Pipecat\)$/);
    }
    expect(elevenLabsAgentRows('LiveKit')[0]).toEqual(['elevenlabs', 'gemini-2.5-flash', 'ElevenLabs Agents, Gemini 2.5 Flash (LiveKit)']);
    expect(modelSupportsExternalTts(ROW)).toBe(false);
  });

  test('the LiveKit registry offers the same LLMs as the server list', () => {
    // The TS registry (agents/livekit/lib/livekit-model-registry.ts) is compiled into dist
    // and cannot import lib/elevenlabs-agents.js, so the two lists are kept by hand.
    const livekitIds = Object.keys(livekitModelIdFlags).filter((id) => id.startsWith('elevenlabs/'));
    expect(livekitIds).toEqual(ELEVENLABS_AGENT_LLMS.map(({ id }) => `elevenlabs/${id}`));
    for (const id of livekitIds) {
      expect(livekitModelIdFlags[id]).toEqual({ voiceStack: 'realtime', audioModel: true, pipeline: false });
      expect(modelSupportsExternalTts(`livekit:${id}`)).toBe(false);
      const row = LivekitModel.allModels.find(([rowId]) => rowId === id);
      expect(row[1]).toMatch(/^ElevenLabs Agents, .* \(Livekit realtime\)$/);
    }
    expect(nativeTtsVendorForModel('livekit:elevenlabs/gemini-2.5-flash')).toBe('elevenlabs');
  });

  test('isElevenLabsAgentsModelName matches the rows on any handler and nothing else', () => {
    expect(isElevenLabsAgentsModelName(ROW)).toBe(true);
    expect(isElevenLabsAgentsModelName('livekit:elevenlabs/claude-haiku-5-5')).toBe(true);
    expect(isElevenLabsAgentsModelName('pipecat:openai/gpt-realtime')).toBe(false);
    expect(isElevenLabsAgentsModelName('elevenlabs/gemini-2.5-flash')).toBe(false);
    expect(isElevenLabsAgentsModelName(undefined)).toBe(false);
  });

  test('elevenlabs is the native TTS vendor of the rows', () => {
    expect(nativeTtsVendorForModel(ROW)).toBe('elevenlabs');
    expect(isExternalTtsForModel({ modelName: ROW, vendor: 'elevenlabs' })).toBe(false);
    expect(isExternalTtsForModel({ modelName: ROW, vendor: 'elevenlabs/eleven_flash_v2_5' })).toBe(false);
    expect(isExternalTtsForModel({ modelName: ROW, vendor: 'cartesia' })).toBe(true);
  });
});

describe('ElevenLabs Agents voices', () => {
  const fakeTree = {
    xAI: { any: [{ name: 'eve' }] },
    OpenAI: { any: [{ name: 'alloy' }] },
    elevenlabs: groupByLocale(catalogue),
    ultravox: { any: [{ name: 'Mark' }] },
  };
  const Handler = { voices: Promise.resolve(fakeTree) };

  test('the rows see the ElevenLabs block only, under its own locales', async () => {
    const names = await getVoiceNamesForAgentValidation({ modelName: ROW, Handler, voicesInstance: {} });
    expect([...names].sort()).toEqual([ELEVENLABS_DEFAULT_VOICE, 'v-brit', 'v-us'].sort());
    const vendors = await getTtsVendorsForAgentValidation({ modelName: ROW, Handler, voicesInstance: {} });
    expect([...vendors]).toEqual(['elevenlabs']);
    // the other realtime rows never see it
    const grok = await getTtsVendorsForAgentValidation({ modelName: 'pipecat:xai/grok-voice-think-fast-2.0', Handler, voicesInstance: {} });
    expect([...grok]).toEqual(['xai']);
    const openai = await getVoiceNamesForAgentValidation({ modelName: 'pipecat:openai/gpt-realtime', Handler, voicesInstance: {} });
    expect(openai.has('v-brit')).toBe(false);
  });

  test('groupByLocale keys the catalogue rows by the locale the accent gives', () => {
    const tree = groupByLocale(catalogue);
    expect(Object.keys(tree).sort()).toEqual(['en-GB', 'en-US']);
    expect(tree['en-GB']).toEqual([{ name: 'v-brit', gender: 'female', description: 'Alice - young', language: undefined }]);
  });

  test('xilabsVoiceTree publishes the catalogue under elevenlabs, or nothing without a key', async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    try {
      delete process.env.ELEVENLABS_API_KEY;
      expect(await xilabsVoiceTree(console)).toEqual({});
      process.env.ELEVENLABS_API_KEY = 'test';
      seedXiLabsVoices(catalogue);
      const tree = await xilabsVoiceTree({ warn() {} });
      expect(Object.keys(tree)).toEqual(['elevenlabs']);
      expect(tree.elevenlabs['en-US'].map((v) => v.name)).toEqual(['v-us', ELEVENLABS_DEFAULT_VOICE]);
    } finally {
      resetXiLabsVoicesCache();
      if (key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = key;
    }
  });
});

describe('ElevenLabs Agents save-time rules', () => {
  const rest = (name) => ({ name, implementation: 'rest', url: 'https://example.com', description: name });

  test('a reserved system-tool name is refused on the rows and allowed elsewhere', () => {
    expect(ELEVENLABS_RESERVED_TOOL_NAMES.has('end_call')).toBe(true);
    expect(() => validateElevenLabsAgent({ modelName: ROW, functions: [rest('get_slots'), rest('end_call')] }))
      .toThrow(/"end_call" reserved by ElevenLabs/);
    expect(() => validateElevenLabsAgent({ modelName: ROW, functions: { skip_turn: rest('skip_turn'), transfer_to_number: rest('transfer_to_number') } }))
      .toThrow(/"skip_turn", "transfer_to_number"/);
    expect(() => validateElevenLabsAgent({ modelName: 'pipecat:openai/gpt-realtime', functions: [rest('end_call')] })).not.toThrow();
    expect(() => validateElevenLabsAgent({ modelName: ROW, functions: [rest('hangup'), rest('transfer')] })).not.toThrow();
  });

  test('vendorSpecific.elevenlabs takes conversation_config tuning and nothing the platform owns', () => {
    const ok = { vendorSpecific: { elevenlabs: { conversation_config: {
      turn: { turn_eagerness: 'eager', turn_timeout: 10 },
      tts: { model_id: 'eleven_turbo_v2_5', stability: 0.4 },
      asr: { keywords: ['Aplisay'] },
      agent: { prompt: { reasoning_effort: 'low' } },
    } } } };
    expect(() => validateElevenLabsAgent({ modelName: ROW, options: ok })).not.toThrow();
    expect(elevenLabsVendorBlock(ok)).toBe(ok.vendorSpecific.elevenlabs);
    expect(elevenLabsVendorBlock({ vendorSpecific: { elevenlabs: [] } })).toBeNull();
    expect(elevenLabsVendorBlock({})).toBeNull();
    for (const path of ['agent.prompt.llm', 'agent.prompt.tools', 'agent.first_message', 'tts.voice_id', 'conversation.text_only']) {
      expect(ELEVENLABS_PROTECTED_CONFIG_PATHS.has(path)).toBe(true);
      const config = {};
      let cursor = config;
      const parts = path.split('.');
      parts.slice(0, -1).forEach((p) => { cursor[p] = {}; cursor = cursor[p]; });
      cursor[parts.at(-1)] = 'x';
      expect(() => validateElevenLabsAgent({ modelName: ROW, options: { vendorSpecific: { elevenlabs: { conversation_config: config } } } }))
        .toThrow(new RegExp(`conversation_config\\.${path.replace(/\./g, '\\.')} is set by the platform`));
    }
    expect(() => validateElevenLabsAgent({ modelName: ROW, options: { vendorSpecific: { elevenlabs: { platform_settings: {} } } } }))
      .toThrow(/platform_settings is not accepted/);
    expect(() => validateElevenLabsAgent({ modelName: ROW, options: { vendorSpecific: { elevenlabs: 'x' } } }))
      .toThrow(/must be an object/);
    expect(() => validateElevenLabsAgent({ modelName: ROW, options: { vendorSpecific: { elevenlabs: { conversation_config: [] } } } }))
      .toThrow(/conversation_config must be an object/);
    // another vendor's block, or none, is not this rule's business
    expect(() => validateElevenLabsAgent({ modelName: ROW, options: { vendorSpecific: { xai: { session: {} } } } })).not.toThrow();
    expect(() => validateElevenLabsAgent({ modelName: 'pipecat:xai/grok-voice-think-fast-2.0', options: { vendorSpecific: { elevenlabs: { platform_settings: {} } } } })).not.toThrow();
  });
});

describe('ElevenLabs Agents billing', () => {
  test('the rows are minute-billed on the voice row and their speech is not a bundled tts component', () => {
    for (const { id } of ELEVENLABS_AGENT_LLMS) {
      expect(isMinuteBilledModel(`pipecat:elevenlabs/${id}`)).toBe(true);
      expect(isMinuteBilledModel(`livekit:elevenlabs/${id}`)).toBe(true);
    }
    // the pipeline TTS vendor of the same name is not a model
    expect(isMinuteBilledModel('pipecat:openai/gpt-4o')).toBe(false);
    expect(isMinuteBilledModel('elevenlabs')).toBe(false);
    expect(BUNDLED_TTS_PROVIDERS).not.toContain('elevenlabs');
    const comps = buildRateComponents({ implementations: [], models: [{ name: ROW, description: 'EL' }] });
    expect(comps.find((c) => c.key === `model:${ROW}`)).toMatchObject({ units: ['minute'], match: { technology: 'voice', detail: ROW } });
  });

  test('the rate-line script plans one minute line per row and leaves present lines alone', () => {
    expect(DEFAULT_VOICE_MODELS).toEqual(ELEVENLABS_AGENT_LLMS.flatMap(({ id }) => [`pipecat:elevenlabs/${id}`, `livekit:elevenlabs/${id}`]));
    const additions = elevenLabsAdditions([], { voicePrice: 8000 });
    expect(additions).toHaveLength(8);
    expect(additions[0]).toEqual({ dim: 'model', match: { technology: 'voice', detail: ROW }, unit: 'minute', priceMicros: 8000 });
    const again = elevenLabsAdditions(additions, { voicePrice: 9000 });
    expect(again).toEqual([]);
    const some = elevenLabsAdditions([additions[0]], { voiceModels: [ROW, 'livekit:elevenlabs/gpt-5.4-mini'], voicePrice: 8000 });
    expect(some.map((l) => l.match.detail)).toEqual(['livekit:elevenlabs/gpt-5.4-mini']);
    expect(DEFAULT_VOICE_MODELS.filter((m) => m.startsWith('livekit:'))).toHaveLength(ELEVENLABS_AGENT_LLMS.length);
  });
});
