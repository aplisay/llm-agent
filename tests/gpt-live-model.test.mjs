import PipecatModel, {
  isPipecatGptLiveModelId,
  pipecatModelIdFlags,
  pipecatModelSupportsDelegation,
  pipecatModelSupportsExternalTts,
} from '../lib/models/pipecat.js';
import {
  getTtsVendorsForAgentValidation,
  getVoiceNamesForAgentValidation,
  modelSupportsDelegation,
  modelSupportsExternalTts,
} from '../lib/model-voices.js';
import { OPENAI_LIVE_DEFAULT_VOICE, OPENAI_LIVE_VOICES, openaiLiveVoiceTree } from '../lib/voices/openai-live.js';
import { buildRateComponents, isMinuteBilledModel } from '../lib/rate-components.js';
import {
  AGENT_TARGET_PLATFORMS,
  AgentSetValidationError,
  delegateToolCollisions,
  fixupLabelReferences,
  validateAgentTargets,
  validateDelegateToolCollisions,
} from '../lib/agent-set-labels.js';

/**
 * GPT-Live (docs/gpt-live.md) on the server: the pipecat roster row and its
 * per-model flags, the model-scoped voice list, the minute-billed rate
 * component, and the `delegate` builtin in agent-set label handling. The
 * save-time validation of `delegate` on an agent row is tests/agent-delegate-function.test.mjs.
 */

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const VOICE_A = '11111111-1111-4111-8111-111111111111';
const TEXT_B = '22222222-2222-4222-8222-222222222222';

function delegateFunction(target, name = 'brain') {
  return {
    name,
    implementation: 'builtin',
    platform: 'delegate',
    description: 'The backend',
    input_schema: { type: 'object', properties: { agent: { type: 'string', source: 'static', from: target } } },
  };
}

describe('GPT-Live roster row', () => {
  test('is a realtime row with delegation and without external TTS', () => {
    expect(pipecatModelIdFlags['openai/gpt-live-1']).toEqual({
      voiceStack: 'realtime', audioModel: true, pipeline: false, externalTts: false, delegation: true,
    });
    expect(pipecatModelSupportsDelegation('openai/gpt-live-1')).toBe(true);
    expect(pipecatModelSupportsExternalTts('openai/gpt-live-1')).toBe(false);
    expect(modelSupportsDelegation(GPT_LIVE)).toBe(true);
    expect(modelSupportsExternalTts(GPT_LIVE)).toBe(false);
  });

  test('the flag is per model id: the OpenAI Realtime row keeps its external TTS and has no delegation', () => {
    expect(pipecatModelIdFlags['openai/gpt-realtime']).toMatchObject({ externalTts: true });
    expect(pipecatModelIdFlags['openai/gpt-realtime'].delegation).toBeUndefined();
    expect(pipecatModelSupportsDelegation('openai/gpt-realtime')).toBe(false);
    expect(modelSupportsDelegation('pipecat:openai/gpt-realtime')).toBe(false);
    expect(modelSupportsDelegation('pipecat:ultravox/ultravox-v0.7')).toBe(false);
    expect(modelSupportsDelegation('livekit:openai/gpt-realtime')).toBe(false);
    expect(modelSupportsDelegation('text:openai/gpt-5.6-luna')).toBe(false);
    expect(modelSupportsDelegation('nonsense')).toBe(false);
  });

  test('allModels carries the same flags the handler exposes as hasDelegation', () => {
    const row = PipecatModel.allModels.find(([id]) => id === 'openai/gpt-live-1');
    expect(row).toBeDefined();
    expect(row[1]).toBe('OpenAI GPT-Live (Pipecat)');
    expect(row[2]).toMatchObject({ delegation: true, externalTts: false });
    const flagged = PipecatModel.allModels.filter(([, , flags]) => flags.delegation === true).map(([id]) => id);
    expect(flagged).toEqual(['openai/gpt-live-1']);
  });

  test('isPipecatGptLiveModelId matches the GPT-Live ids only', () => {
    expect(isPipecatGptLiveModelId('openai/gpt-live-1')).toBe(true);
    expect(isPipecatGptLiveModelId('openai/gpt-live-2')).toBe(true);
    expect(isPipecatGptLiveModelId('openai/gpt-realtime')).toBe(false);
    expect(isPipecatGptLiveModelId('')).toBe(false);
    expect(isPipecatGptLiveModelId(undefined)).toBe(false);
  });
});

describe('GPT-Live voices', () => {
  // The handler's merged catalogue: the OpenAI Realtime list plus other vendors.
  const Handler = {
    voices: Promise.resolve({
      OpenAI: { any: [{ name: 'alloy' }, { name: 'onyx' }, { name: 'nova' }] },
      google: { any: [{ name: 'Kore' }] },
      ultravox: { any: [{ name: 'Mark' }] },
    }),
  };
  const voicesInstance = { listVoices: async () => ({ elevenlabs: { 'en-GB': [{ name: 'Rachel' }] } }) };

  test('the catalogue lists the 22 GPT-Live voices with marin as the default', () => {
    expect(OPENAI_LIVE_VOICES.map((v) => v.name)).toEqual([
      'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cedar', 'cinder', 'coral', 'delta', 'echo', 'gleam',
      'marin', 'meridian', 'quartz', 'ripple', 'sage', 'shimmer', 'stone', 'tempo', 'verse', 'vesper', 'willow',
    ]);
    expect(OPENAI_LIVE_DEFAULT_VOICE).toBe('marin');
    expect(OPENAI_LIVE_VOICES.some((v) => v.name === OPENAI_LIVE_DEFAULT_VOICE)).toBe(true);
    expect(Object.keys(openaiLiveVoiceTree())).toEqual(['OpenAI']);
    expect(Object.keys(openaiLiveVoiceTree().OpenAI)).toEqual(['any']);
  });

  test('a GPT-Live row validates voices against the GPT-Live list, not the Realtime list', async () => {
    const names = await getVoiceNamesForAgentValidation({ modelName: GPT_LIVE, Handler, voicesInstance });
    expect(names.has('marin')).toBe(true);
    expect(names.has('cedar')).toBe(true);
    expect(names.has('alloy')).toBe(true);
    // Realtime-only names are rejected by the Live API.
    expect(names.has('onyx')).toBe(false);
    expect(names.has('nova')).toBe(false);
    // Other vendors never apply to an OpenAI row.
    expect(names.has('Kore')).toBe(false);
    expect(names.has('Mark')).toBe(false);
    expect(names.has('Rachel')).toBe(false);
  });

  test('the OpenAI Realtime row keeps the Realtime list', async () => {
    const names = await getVoiceNamesForAgentValidation({ modelName: 'pipecat:openai/gpt-realtime', Handler, voicesInstance });
    expect(names.has('onyx')).toBe(true);
    expect(names.has('marin')).toBe(false);
  });

  test('the only TTS vendor a GPT-Live row accepts is openai', async () => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName: GPT_LIVE, Handler, voicesInstance });
    expect([...vendors]).toEqual(['openai']);
  });
});

describe('GPT-Live billing', () => {
  test('GPT-Live is minute-billed on its voice row like Ultravox', () => {
    expect(isMinuteBilledModel(GPT_LIVE)).toBe(true);
    expect(isMinuteBilledModel('livekit:ultravox/ultravox-v0.7')).toBe(true);
    expect(isMinuteBilledModel('pipecat:openai/gpt-realtime')).toBe(false);
    expect(isMinuteBilledModel('text:openai/gpt-5.6-luna')).toBe(false);
  });

  test('the rate-component catalogue prices it per minute', () => {
    const comps = buildRateComponents({
      implementations: [{ name: 'pipecat', description: 'Pipecat', hasWebRTC: true, hasTelephony: true }],
      models: [
        { name: GPT_LIVE, description: 'OpenAI GPT-Live (Pipecat)' },
        { name: 'text:openai/gpt-5.6-luna', description: 'OpenAI GPT-5.6 Luna' },
      ],
    });
    const live = comps.find((c) => c.key === `model:${GPT_LIVE}`);
    expect(live.units).toEqual(['minute']);
    expect(live.match).toEqual({ technology: 'voice', detail: GPT_LIVE });
    // The backend model keeps its own token line: that is what prices the delegate's tokens.
    const luna = comps.find((c) => c.key === 'model:text:openai/gpt-5.6-luna');
    expect(luna.units).toEqual(['token']);
    expect(luna.match).toEqual({ technology: 'llm', provider: 'openai', detail: 'openai/gpt-5.6-luna', unit: 'output_tokens' });
  });
});

describe('delegate in agent-set label handling', () => {
  test('delegate is an agent-target platform', () => {
    expect(AGENT_TARGET_PLATFORMS).toEqual(['transfer_agent', 'subagent', 'delegate']);
  });

  test('label references in a delegate function are fixed up and annotated', () => {
    const functions = [delegateFunction('label:brain')];
    fixupLabelReferences(functions, new Map([['brain', TEXT_B]]), 'voice');
    expect(functions[0].input_schema.properties.agent).toEqual({ type: 'string', source: 'static', from: TEXT_B, fromLabel: 'brain' });
    // Round trip: a stored fromLabel re-resolves against a changed set.
    fixupLabelReferences(functions, new Map([['brain', VOICE_A]]), 'voice');
    expect(functions[0].input_schema.properties.agent.from).toBe(VOICE_A);
    expect(() => fixupLabelReferences([delegateFunction('label:missing')], new Map(), 'voice'))
      .toThrow(/references label "missing"/);
  });

  test('a delegate target must be a text agent', async () => {
    const membersById = new Map([[VOICE_A, { type: 'interactive-audio' }], [TEXT_B, { type: 'text' }]]);
    await expect(validateAgentTargets([delegateFunction(TEXT_B)], { membersById, owningLabel: 'voice' })).resolves.toBeUndefined();
    await expect(validateAgentTargets([delegateFunction(VOICE_A)], { membersById, owningLabel: 'voice' }))
      .rejects.toThrow(/function brain \(delegate\) must target a text agent/);
    await expect(validateAgentTargets([delegateFunction(TEXT_B)], { membersById: new Map(), lookupAgent: async () => null, owningLabel: 'voice' }))
      .rejects.toThrow(/does not exist or is not accessible/);
    // metadata-sourced targets are resolved at call time, not here
    const viaMetadata = delegateFunction(TEXT_B);
    viaMetadata.input_schema.properties.agent = { type: 'string', source: 'metadata', from: 'aplisay.backend' };
    await expect(validateAgentTargets([viaMetadata], { membersById: new Map(), owningLabel: 'voice' })).resolves.toBeUndefined();
  });

  test('delegateToolCollisions ignores the delegate declaration and accepts both function shapes', () => {
    const voice = [delegateFunction(TEXT_B), { name: 'get_slots', implementation: 'rest' }, { name: 'hangup', implementation: 'builtin', platform: 'hangup' }];
    const delegate = { get_slots: { name: 'get_slots', implementation: 'rest' }, brain: { name: 'brain', implementation: 'rest' } };
    expect(delegateToolCollisions(voice, delegate)).toEqual(['get_slots']);
    expect(delegateToolCollisions(voice, [])).toEqual([]);
    expect(delegateToolCollisions(undefined, undefined)).toEqual([]);
  });

  test('validateDelegateToolCollisions rejects an in-set pair sharing a function name', () => {
    const members = [
      { label: 'voice', id: VOICE_A, functions: [delegateFunction(TEXT_B), { name: 'get_slots', implementation: 'rest' }] },
      { label: 'brain', id: TEXT_B, functions: [{ name: 'get_slots', implementation: 'rest' }] },
    ];
    expect(() => validateDelegateToolCollisions(members)).toThrow(AgentSetValidationError);
    expect(() => validateDelegateToolCollisions(members)).toThrow(/delegates to "brain", but both agents declare a function named "get_slots"/);
    members[1].functions = [{ name: 'check_slots', implementation: 'rest' }];
    expect(() => validateDelegateToolCollisions(members)).not.toThrow();
    // A delegate outside the set is checked by the worker at call start, not here.
    const outside = [{ label: 'voice', id: VOICE_A, functions: [delegateFunction('33333333-3333-4333-8333-333333333333'), { name: 'x' }] }];
    expect(() => validateDelegateToolCollisions(outside)).not.toThrow();
  });
});
