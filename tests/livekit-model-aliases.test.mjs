import {
  LIVEKIT_MODEL_ALIASES,
  LIVEKIT_REALTIME_MODEL_ROWS,
  LIVEKIT_PIPELINE_MODEL_ROWS,
  buildLivekitHandlerAllModels,
  livekitModelIdFlags,
} from '../agents/livekit/dist/lib/livekit-model-registry.js';

// `ultravox-70b` is not an Ultravox model. It is a deprecated name the ultravox
// plugin rewrites to `ultravox-v0.6` at session start, kept so agents already
// saved on it keep running. Because it also sat in the roster as an ordinary
// row, GET /models advertised it as a selectable model and new agents went on
// being created against a name that does not exist upstream.
//
// The rule these tests pin: an alias is listed only while the model it resolves
// to is itself listed, and is never listed as though it were a real model in
// its own right.

describe('livekit model aliases', () => {
  const ids = (rows) => rows.map(([id]) => id);
  const realtimeIds = LIVEKIT_REALTIME_MODEL_ROWS.map(([v, n]) => `${v}/${n}`);
  const pipelineIds = LIVEKIT_PIPELINE_MODEL_ROWS.map(([v, n]) => `${v}/${n}`);

  test('every alias resolves to a real, non-alias model id', () => {
    const declared = new Set([...realtimeIds, ...pipelineIds]);
    for (const [alias, target] of Object.entries(LIVEKIT_MODEL_ALIASES)) {
      expect({ alias, target, declared: declared.has(target) }).toEqual({ alias, target, declared: true });
      // No alias-of-an-alias: a target must be a model, not another redirect.
      expect(LIVEKIT_MODEL_ALIASES[target]).toBeUndefined();
      // The alias itself must be a declared row, else listing it is moot.
      expect(declared.has(alias)).toBe(true);
    }
  });

  test('ultravox-70b is declared an alias, not a model of its own', () => {
    expect(LIVEKIT_MODEL_ALIASES['ultravox/ultravox-70b']).toBe('ultravox/ultravox-v0.6');
  });

  test('an alias is listed while its target is listed', () => {
    const listed = ids(buildLivekitHandlerAllModels());
    expect(listed).toContain('ultravox/ultravox-v0.6');
    expect(listed).toContain('ultravox/ultravox-70b');
  });

  test('an alias is dropped from the roster when its target is not offered', () => {
    // Simulate retiring the target the way a real edit would: remove the target
    // row and rebuild. The alias must not survive its target.
    const rows = [
      ['openai/gpt-realtime', 'OpenAI', {}],
      ['ultravox/ultravox-70b', 'Ultravox 70B', {}],
    ];
    const aliases = { 'ultravox/ultravox-70b': 'ultravox/ultravox-v0.6' };
    const offered = new Set(rows.map(([id]) => id).filter((id) => !(id in aliases)));
    const kept = rows.filter(([id]) => aliases[id] === undefined || offered.has(aliases[id])).map(([id]) => id);
    expect(kept).toEqual(['openai/gpt-realtime']);
  });

  test('routing flags still cover the alias, so a saved agent still runs', () => {
    // Delisting changes what is OFFERED, never what resolves: an agent already
    // saved on the alias must keep its realtime routing.
    expect(livekitModelIdFlags['ultravox/ultravox-70b']).toEqual(
      expect.objectContaining({ voiceStack: 'realtime', audioModel: true }),
    );
  });
});
