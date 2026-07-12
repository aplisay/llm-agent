import { SYSTEM_PROMPT } from '../lib/set-builder-agent.js';
import { pipecatModelIdFlags } from '../lib/models/pipecat.js';
import { livekitModelIdFlags } from '../agents/livekit/dist/lib/livekit-model-registry.js';
import Anthropic from '../lib/models/anthropic.js';

// The builder prompt tells the model "Never invent a model name" and then
// quotes example model ids — so every id the prompt quotes must actually exist
// in the corresponding handler registry. A phantom example (this caught
// "pipecat:openai/gpt-4o-realtime") is worse than a rejected save: model ids
// are not validated at create time, so an agent copying the example saves
// fine and then fails at call time. Placeholder ids ending "..." are skipped —
// they illustrate a prefix, not a model.

describe('set-builder prompt model examples', () => {
  const quoted = [...SYSTEM_PROMPT.matchAll(/"(pipecat|livekit|text|jambonz|ultravox):([a-z0-9_-]+)\/([A-Za-z0-9._-]+)"/g)]
    .map(([, handler, provider, model]) => ({ handler, id: `${provider}/${model}` }))
    .filter((q) => !q.id.endsWith('...'));

  test('the prompt quotes at least one handler-prefixed example', () => {
    expect(quoted.length).toBeGreaterThan(0);
  });

  test('every pipecat: example exists in the pipecat model registry', () => {
    for (const { handler, id } of quoted.filter((q) => q.handler === 'pipecat')) {
      expect({ handler, id, known: !!pipecatModelIdFlags[id] }).toEqual({ handler, id, known: true });
    }
  });

  test('every livekit: example exists in the livekit model registry', () => {
    for (const { handler, id } of quoted.filter((q) => q.handler === 'livekit')) {
      expect({ handler, id, known: !!livekitModelIdFlags[id] }).toEqual({ handler, id, known: true });
    }
  });

  test('every text: example exists in a text-driver model list', () => {
    const known = new Set(Anthropic.allModels.map(([id]) => id));
    for (const { handler, id } of quoted.filter((q) => q.handler === 'text')) {
      expect({ handler, id, known: known.has(id) }).toEqual({ handler, id, known: true });
    }
  });

  test('the retired gpt-4o-realtime example is gone', () => {
    expect(SYSTEM_PROMPT).not.toContain('gpt-4o-realtime');
  });
});
