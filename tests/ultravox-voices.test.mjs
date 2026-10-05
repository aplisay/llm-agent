import { jest } from '@jest/globals';
// First: it points lib/database.js, which the handlers import, at the test database.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import Ultravox, { loadUltravoxVoices } from '../lib/handlers/ultravox.js';
import Livekit from '../lib/handlers/livekit.js';
import Pipecat from '../lib/handlers/pipecat.js';

/**
 * The Ultravox voice catalogue, which includes the account's private (cloned) voices. It was
 * fetched once per process, and LiveKit and Pipecat copied it at start, so a voice cloned after
 * start stayed missing from lists and agent saves until a restart (staging, 2026-10-05).
 */

const page = (results, next = null) => ({ data: { results, next } });

describe('Ultravox voice catalogue', () => {
  beforeAll(() => setupRealDatabase());
  afterAll(() => teardownRealDatabase());

  test('follows every page and maps names, descriptions and providers', async () => {
    const pages = {
      '/voices': page([
        { voiceId: 'id-mark', name: 'Mark', description: 'Energetic', provider: 'Inworld' },
      ], '/voices?cursor=2'),
      '/voices?cursor=2': page([
        { voiceId: 'id-lisa', name: 'Lisa', description: 'Voice cloned at 2026-10-02', provider: 'Eleven Labs' },
        { voiceId: 'id-long', name: 'A voice name of more than twenty', description: '', provider: 'Cartesia' },
      ]),
    };
    const requested = [];
    const { tree, providers } = await loadUltravoxVoices({
      get: async (url) => { requested.push(url); return pages[url]; },
    });
    expect(requested).toEqual(['/voices', '/voices?cursor=2']);
    expect(tree).toEqual({
      ultravox: {
        any: [
          { name: 'Mark', description: 'Mark - Energetic', gender: 'unknown' },
          { name: 'Lisa', description: 'Lisa - Voice cloned at 2026-10-02', gender: 'unknown' },
          { name: 'A voice name of more than twenty', description: 'A voice name of more than twenty', gender: 'unknown' },
        ],
      },
    });
    expect(providers.get('Lisa')).toBe('Eleven Labs');
    expect(providers.get('id-lisa')).toBe('Eleven Labs');
  });

  describe('handlers read the current catalogue on every call', () => {
    const before = { ultravox: { any: [{ name: 'Mark', description: 'Mark', gender: 'unknown' }] } };
    const after = { ultravox: { any: [...before.ultravox.any, { name: 'Lisa', description: 'Lisa', gender: 'unknown' }] } };
    const names = (tree) => tree.ultravox.any.map((v) => v.name);
    let spy;
    afterEach(() => spy?.mockRestore());

    test.each([['LiveKit', Livekit], ['Pipecat', Pipecat]])('%s', async (_, Handler) => {
      spy = jest.spyOn(Ultravox, 'voices', 'get').mockReturnValueOnce(Promise.resolve(before));
      expect(names(await Handler.voices)).toEqual(['Mark']);
      spy.mockReturnValueOnce(Promise.resolve(after));
      expect(names(await Handler.voices)).toEqual(['Mark', 'Lisa']);
    });

    test.each([['LiveKit', Livekit], ['Pipecat', Pipecat]])('%s keeps its other voices when Ultravox fails', async (_, Handler) => {
      spy = jest.spyOn(Ultravox, 'voices', 'get').mockReturnValueOnce(Promise.reject(new Error('HTTP 503')));
      const tree = await Handler.voices;
      expect(tree.ultravox).toBeUndefined();
      expect(tree.OpenAI.any.length).toBeGreaterThan(0);
    });
  });
});
