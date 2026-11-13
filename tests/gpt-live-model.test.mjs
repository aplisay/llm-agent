import PipecatModel, {
  isPipecatGptLiveModelId,
  pipecatModelIdFlags,
  pipecatModelSupportsDelegation,
  pipecatModelSupportsExternalTts,
} from '../lib/models/pipecat.js';
import LivekitModel, { livekitModelIdFlags } from '../lib/models/livekit.js';
import {
  filterVoiceTreeBySearch,
  getTtsVendorsForAgentValidation,
  getVoiceNamesForAgentValidation,
  modelSupportsDelegation,
  modelSupportsExternalTts,
  normalizeSearchTerms,
} from '../lib/model-voices.js';
import { OPENAI_LIVE_DEFAULT_VOICE, OPENAI_LIVE_VOICES, openaiLiveVoiceTree } from '../lib/voices/openai-live.js';
import { buildRateComponents, isMinuteBilledModel } from '../lib/rate-components.js';
import {
  AGENT_TARGET_PLATFORMS,
  AgentSetValidationError,
  assertNotDelegateWithResult,
  conversingReferrers,
  delegateToolCollisions,
  fixupLabelReferences,
  keyedCopiesShadowedByDelegate,
  runsHostedDelegation,
  unusableDelegateResults,
  validateAgentTargets,
  validateDelegateResultContracts,
  validateDelegateToolCollisions,
} from '../lib/agent-set-labels.js';

/**
 * GPT-Live (docs/gpt-live.md) on the server: the pipecat roster row and its
 * per-model flags, the model-scoped voice list, the minute-billed rate
 * component, and the `delegate` builtin in agent-set label handling. The
 * save-time validation of `delegate` on an agent row is tests/agent-delegate-function.test.mjs.
 */

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const LIVEKIT_GPT_LIVE = 'livekit:openai/gpt-live-1';
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

describe('GPT-Live LiveKit row', () => {
  test('is a realtime row with delegation and without external TTS', () => {
    expect(livekitModelIdFlags['openai/gpt-live-1']).toEqual({
      voiceStack: 'realtime', audioModel: true, pipeline: false, externalTts: false, delegation: true,
    });
    expect(modelSupportsDelegation(LIVEKIT_GPT_LIVE)).toBe(true);
    expect(modelSupportsExternalTts(LIVEKIT_GPT_LIVE)).toBe(false);
    expect(livekitModelIdFlags['openai/gpt-realtime']).toMatchObject({ externalTts: true });
    expect(livekitModelIdFlags['openai/gpt-realtime'].delegation).toBeUndefined();
    expect(isMinuteBilledModel(LIVEKIT_GPT_LIVE)).toBe(true);
  });

  test('allModels carries the same flags the handler exposes as hasDelegation', () => {
    const row = LivekitModel.allModels.find(([id]) => id === 'openai/gpt-live-1');
    expect(row).toBeDefined();
    expect(row[1]).toBe('OpenAI GPT-Live (Livekit realtime)');
    expect(row[2]).toMatchObject({ delegation: true, externalTts: false });
    const flagged = LivekitModel.allModels.filter(([, , flags]) => flags.delegation === true).map(([id]) => id);
    expect(flagged).toEqual(['openai/gpt-live-1']);
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

  test.each([GPT_LIVE, LIVEKIT_GPT_LIVE])('%s validates voices against the GPT-Live list, not the Realtime list', async (modelName) => {
    const names = await getVoiceNamesForAgentValidation({ modelName, Handler, voicesInstance });
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

  test.each([GPT_LIVE, LIVEKIT_GPT_LIVE])('the only TTS vendor %s accepts is openai', async (modelName) => {
    const vendors = await getTtsVendorsForAgentValidation({ modelName, Handler, voicesInstance });
    expect([...vendors]).toEqual(['openai']);
  });

  // The list_voices search over the GPT-Live block, ranked as the builtin returns it.
  const searchNames = (terms) =>
    (filterVoiceTreeBySearch(openaiLiveVoiceTree(), normalizeSearchTerms(terms)).vendors.OpenAI ?? []).map((v) => v.name);

  test('every voice has a gender and a description beyond its name', () => {
    for (const v of OPENAI_LIVE_VOICES) {
      expect(['male', 'female']).toContain(v.gender);
      expect(v.description.length).toBeGreaterThan(v.name.length);
    }
  });

  test('a British search finds vesper and the two Irish voices, and nothing else', () => {
    for (const term of ['british', 'brit', 'uk']) {
      expect(searchNames([term])).toEqual(['stone', 'vesper', 'willow']);
    }
    expect(searchNames(['irish'])).toEqual(['stone', 'willow']);
  });

  test('a US search finds the Southern US voices by "us", "usa" or "american", and never the Irish voices', () => {
    // No description names another accent to compare with, so "us" stays on the US voices.
    expect(searchNames(['us'])).toEqual(['cinder', 'delta']);
    expect(searchNames(['usa'])).toEqual(['cinder', 'delta']);
    // "North American" also matches "american".
    expect(searchNames(['american'])).toEqual(['cinder', 'delta', 'gleam', 'meridian']);
  });

  test('a British search with a gender puts the British voices of that gender first', () => {
    expect(searchNames(['british', 'female'])[0]).toBe('willow');
    expect(searchNames(['british', 'english', 'female'])[0]).toBe('willow');
    expect(searchNames(['british', 'male']).slice(0, 2)).toEqual(['stone', 'vesper']);
    expect(searchNames(['uk', 'english', 'male']).slice(0, 2)).toEqual(['stone', 'vesper']);
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

  test('validateDelegateToolCollisions says to use removeFunctions when a clashing function is keyed', () => {
    const members = [
      { label: 'voice', id: VOICE_A, functions: [delegateFunction(TEXT_B), { name: 'get_slots', implementation: 'rest' }] },
      { label: 'brain', id: TEXT_B, functions: [{ name: 'get_slots', implementation: 'rest', key: 'BOOKING_TOKEN' }] },
    ];
    expect(() => validateDelegateToolCollisions(members)).toThrow(/remove one copy of each .*removeFunctions/);
    members[1].functions = [{ name: 'get_slots', implementation: 'rest' }];
    expect(() => validateDelegateToolCollisions(members)).toThrow(/rename one so the backend tool set has no duplicate names$/);
  });

  test('keyedCopiesShadowedByDelegate names keyed voice copies kept by omission that the delegate declares', () => {
    const keyed = (name) => ({ name, implementation: 'rest', key: 'BOOKING_TOKEN' });
    const voice = {
      label: 'voice',
      id: VOICE_A,
      functions: [delegateFunction(TEXT_B), keyed('get_slots'), keyed('book_slot'), keyed('send_summary'), { name: 'lookup', implementation: 'rest' }],
      sentNames: new Set(['brain', 'book_slot', 'lookup']),
    };
    const brain = {
      label: 'brain',
      id: TEXT_B,
      functions: { get_slots: keyed('get_slots'), book_slot: keyed('book_slot'), lookup: { name: 'lookup', implementation: 'rest' } },
    };
    // book_slot and lookup were sent, so they are a clash the document wrote;
    // send_summary has no copy on the delegate.
    expect(keyedCopiesShadowedByDelegate([voice, brain])).toEqual(new Map([[VOICE_A, ['get_slots']]]));
    // A member the document sent no functions for keeps what it stores.
    expect(keyedCopiesShadowedByDelegate([{ ...voice, sentNames: undefined }, brain]).size).toBe(0);
    // A delegate outside the set is not checked here.
    expect(keyedCopiesShadowedByDelegate([voice]).size).toBe(0);
  });
});

describe('a result builtin on a GPT-Live backend', () => {
  const HOSTED = 'text:openai/gpt-5.6-terra';
  const CLIENT = 'text:anthropic/claude-sonnet-4-5';
  const resultFunction = (name = 'deliver_answer') => ({
    name,
    implementation: 'builtin',
    platform: 'result',
    input_schema: { properties: { answer: { type: 'string', required: true } } },
  });
  const voice = () => ({ label: 'voice', id: VOICE_A, modelName: GPT_LIVE, functions: [delegateFunction(TEXT_B)] });

  test('runsHostedDelegation matches the worker: an openai/ model after the handler prefix', () => {
    for (const modelName of [HOSTED, 'text:OpenAI/gpt-5.6-luna', 'openai/gpt-5.6-terra', ' text:openai/x ']) {
      expect(runsHostedDelegation(modelName)).toBe(true);
    }
    for (const modelName of [CLIENT, 'text:google/gemini-2.5-pro', 'text:openrouter/openai/gpt-5', '', undefined, null]) {
      expect(runsHostedDelegation(modelName)).toBe(false);
    }
  });

  test('unusableDelegateResults names result builtins on a hosted model only, in either function shape', () => {
    const functions = [resultFunction(), { name: 'notify_email_team', implementation: 'rest' }];
    expect(unusableDelegateResults({ modelName: HOSTED, functions })).toEqual(['deliver_answer']);
    expect(unusableDelegateResults({ modelName: HOSTED, functions: { deliver_answer: resultFunction() } })).toEqual(['deliver_answer']);
    // Client delegation runs through the subagent endpoint, where result is the output contract.
    expect(unusableDelegateResults({ modelName: CLIENT, functions })).toEqual([]);
    expect(unusableDelegateResults({ modelName: HOSTED, functions: [{ name: 'x', implementation: 'rest', platform: 'result' }] })).toEqual([]);
    expect(unusableDelegateResults({ modelName: HOSTED })).toEqual([]);
    expect(unusableDelegateResults(undefined)).toEqual([]);
  });

  test('validateDelegateResultContracts rejects an in-set hosted backend that carries one', () => {
    const backend = { label: 'backend', id: TEXT_B, modelName: HOSTED, functions: [resultFunction('backend_result')] };
    expect(() => validateDelegateResultContracts([voice(), backend])).toThrow(AgentSetValidationError);
    expect(() => validateDelegateResultContracts([voice(), backend]))
      .toThrow(/Agent "backend" is the GPT-Live backend of "voice" \(function brain\) and runs text:openai\/gpt-5\.6-terra.*remove its result function "backend_result" \(list it in removeFunctions\)/);
    expect(() => validateDelegateResultContracts([voice(), { ...backend, modelName: CLIENT }])).not.toThrow();
    expect(() => validateDelegateResultContracts([voice(), { ...backend, functions: [] }])).not.toThrow();
    // A delegate outside the set is checked against its stored row by validateAgentTargets.
    expect(() => validateDelegateResultContracts([voice()])).not.toThrow();
  });

  test('validateAgentTargets checks a delegate target it looks up, and leaves in-set targets to the set check', async () => {
    const stored = { id: TEXT_B, name: 'Stored backend', type: 'text', modelName: HOSTED, functions: [resultFunction()] };
    await expect(validateAgentTargets([delegateFunction(TEXT_B)], { lookupAgent: async () => stored, owningLabel: 'voice' }))
      .rejects.toThrow(/Agent "Stored backend" is the GPT-Live backend of "voice" \(function brain \(delegate\)\)/);
    await expect(validateAgentTargets([delegateFunction(TEXT_B)], { lookupAgent: async () => ({ ...stored, modelName: CLIENT }), owningLabel: 'voice' }))
      .resolves.toBeUndefined();
    const membersById = new Map([[TEXT_B, { type: 'text', modelName: HOSTED }]]);
    await expect(validateAgentTargets([delegateFunction(TEXT_B)], { membersById, owningLabel: 'voice' })).resolves.toBeUndefined();
    // A subagent target keeps its result contract.
    const subagent = { ...delegateFunction(TEXT_B, 'ask_knowledge'), platform: 'subagent' };
    await expect(validateAgentTargets([subagent], { lookupAgent: async () => stored, owningLabel: 'voice' })).resolves.toBeUndefined();
  });

  test('assertNotDelegateWithResult refuses the target side only when something delegates to it', () => {
    const backend = { modelName: HOSTED, functions: [resultFunction()] };
    const agents = [{ id: VOICE_A, name: 'Reception', functions: [delegateFunction(TEXT_B)] }];
    const referrers = conversingReferrers(TEXT_B, { agents });
    expect(referrers).toEqual([{ agentId: VOICE_A, name: 'Reception', kind: 'delegate', context: 'function brain (delegate)' }]);
    expect(() => assertNotDelegateWithResult({ label: 'backend', agent: backend, referrers }))
      .toThrow(/Agent "backend" is the GPT-Live backend of Reception \(function brain \(delegate\)\)/);
    expect(() => assertNotDelegateWithResult({ label: 'backend', agent: backend, referrers: [] })).not.toThrow();
    // A hand-back summariser is invoked like a subagent, so its result function stays valid.
    const summariser = [{ agentId: VOICE_A, name: 'Reception', kind: 'summaryAgent', context: 'options.bridgedTransferToAgent["1"].summaryAgent' }];
    expect(() => assertNotDelegateWithResult({ label: 'backend', agent: backend, referrers: summariser })).not.toThrow();
  });
});
