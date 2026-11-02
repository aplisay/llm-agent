import { exportVoices, importVoices, main, parseArgs } from '../scripts/platform-voices.mjs';

/**
 * scripts/platform-voices.mjs against two stub API servers: export shape, skip on
 * an existing name, recreate polling, adopt then release, the repair of a
 * half-done adopt on a re-run, and the vendor_voice_not_found message.
 */

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const LIVEKIT_GPT_LIVE = 'livekit:openai/gpt-live-1';
const SOURCE = 'https://source.example';
const TARGET = 'https://target.example';

const voice = (over = {}) => ({
  id: over.id || `id-${over.name}`,
  name: 'Concierge',
  vendor: 'openai',
  method: 'prompt',
  voice: `voice_${over.name || 'x'}`,
  locale: 'en-GB',
  gender: 'female',
  prompt: 'A warm voice.',
  status: 'ready',
  models: [GPT_LIVE, LIVEKIT_GPT_LIVE],
  visibility: 'platform',
  ownership: { state: 'owner' },
  scriptHint: null,
  inUse: { agents: 0, organisations: 0 },
  ...over,
});

/** One stub API server: platform voices, models, and the vendor ids its key can use. */
function stubServer({ voices = [], models = [GPT_LIVE, LIVEKIT_GPT_LIVE], vendorIds = [], pollsUntilReady = 1, failNames = [] } = {}) {
  const server = { voices: voices.map((v) => ({ ...v })), calls: [], polls: new Map() };
  server.handle = (method, path, body) => {
    server.calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/models') {
      return [200, Object.fromEntries(models.map((m) => [m, { description: m }]))];
    }
    if (method === 'GET' && path === '/api/custom-voices?visibility=platform') {
      return [200, { voices: server.voices, quota: { limit: 100, used: server.voices.length, remaining: 100 - server.voices.length } }];
    }
    let m = path.match(/^\/api\/models\/([^/]+)\/voices\/([^/]+)$/);
    if (method === 'POST' && m) {
      if (body.vendorVoiceId && !vendorIds.includes(body.vendorVoiceId)) {
        return [400, { code: 'vendor_voice_not_found', message: 'not found' }];
      }
      const created = voice({
        id: `new-${server.voices.length + 1}`, name: body.name, prompt: body.prompt, locale: decodeURIComponent(m[2]),
        status: body.vendorVoiceId ? 'ready' : 'creating', voice: body.vendorVoiceId || null,
      });
      server.voices.push(created);
      return [202, created];
    }
    m = path.match(/^\/api\/custom-voices\/([^/?]+)$/);
    if (method === 'GET' && m) {
      const v = server.voices.find((x) => x.id === m[1]);
      const n = (server.polls.get(v.id) || 0) + 1;
      server.polls.set(v.id, n);
      if (v.status === 'creating' && n >= pollsUntilReady) {
        Object.assign(v, failNames.includes(v.name)
          ? { status: 'failed', error: 'OpenAI rejected the voice' }
          : { status: 'ready', voice: `voice_made_${v.id}` });
      }
      return [200, v];
    }
    if (method === 'PATCH' && m) {
      const v = server.voices.find((x) => x.id === m[1]);
      if (!v) return [404, { message: 'not found' }];
      if (body.release) v.ownership = { state: 'released', to: body.release.to };
      return [200, v];
    }
    return [404, { message: `no route ${method} ${path}` }];
  };
  return server;
}

function fetchFor(servers) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const server = servers[u.origin];
    if (!server) throw new Error(`no stub for ${u.origin}`);
    expect(init.headers.Authorization).toBe(`Bearer key-${u.origin === SOURCE ? 'source' : 'target'}`);
    const [status, body] = server.handle(init.method || 'GET', `${u.pathname}${u.search}`, init.body ? JSON.parse(init.body) : undefined);
    return { ok: status < 400, status, json: async () => body };
  };
}

const run = (opts) => {
  const lines = [];
  const summary = importVoices({ log: (l) => lines.push(l), sleep: async () => { }, pollMs: 0, key: 'key-target', api: TARGET, ...opts });
  return summary.then((s) => ({ summary: s, lines }));
};

describe('platform-voices script', () => {
  test('parses its arguments, with keys from the environment', () => {
    const opts = parseArgs(['import', 'f.json', '--api', TARGET, '--adopt', '--only', 'X'], { PLATFORM_VOICES_KEY: 'k', PLATFORM_VOICES_SOURCE_KEY: 's' });
    expect(opts).toMatchObject({ command: 'import', file: 'f.json', api: TARGET, adopt: true, only: 'X', key: 'k', sourceKey: 's' });
    expect(() => parseArgs(['export', '--bogus'])).toThrow(/Unknown option/);
  });

  test('exports the ready platform voices with what an import needs', async () => {
    const source = stubServer({
      voices: [
        voice({ name: 'Concierge', scriptHint: 'Hello there', withdrawnAt: undefined }),
        voice({ name: 'Retired', withdrawnAt: '2026-11-01T00:00:00Z' }),
        voice({ name: 'Broken', status: 'failed', voice: null }),
        voice({ name: 'Promoted', ownership: { state: 'released', to: TARGET } }),
      ],
    });
    const data = await exportVoices({
      api: `${SOURCE}/api/`, key: 'key-source', fetchImpl: fetchFor({ [SOURCE]: source }), now: () => new Date('2026-11-02T10:00:00Z'),
    });
    expect(data.source).toBe(SOURCE);
    expect(data.exportedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(data.voices.map((v) => v.name)).toEqual(['Concierge', 'Retired', 'Promoted']);
    expect(data.voices[0]).toEqual({
      id: 'id-Concierge', name: 'Concierge', prompt: 'A warm voice.', scriptHint: 'Hello there', gender: 'female', locale: 'en-GB',
      vendor: 'openai', method: 'prompt', models: [GPT_LIVE, LIVEKIT_GPT_LIVE], vendorVoiceId: 'voice_Concierge',
      withdrawn: false, ownership: 'owner',
    });
    expect(data.voices[1].withdrawn).toBe(true);
    expect(data.voices[2].ownership).toBe('released');

    const out = [];
    const code = await main(['export', '--api', SOURCE, '--key', 'key-source'], {
      fetchImpl: fetchFor({ [SOURCE]: source }), stdout: { write: (s) => out.push(s) }, log: () => { },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('')).voices).toHaveLength(3);
  });

  test('recreates each voice from its prompt, polls it, and skips names the target has', async () => {
    const target = stubServer({ voices: [voice({ id: 't-1', name: 'Existing' })], pollsUntilReady: 2, failNames: ['Rejected'] });
    const data = {
      source: SOURCE,
      voices: [
        { ...voice({ name: 'Existing' }), vendorVoiceId: 'voice_e', withdrawn: false, ownership: 'owner' },
        { ...voice({ name: 'Fresh', scriptHint: 'Hello there' }), vendorVoiceId: 'voice_f', withdrawn: false, ownership: 'owner' },
        { ...voice({ name: 'Rejected' }), vendorVoiceId: 'voice_r', withdrawn: false, ownership: 'owner' },
        { ...voice({ name: 'Retired' }), vendorVoiceId: 'voice_w', withdrawn: true, ownership: 'owner' },
      ],
    };
    const { summary, lines } = await run({ data, fetchImpl: fetchFor({ [TARGET]: target }) });
    expect(summary).toEqual({ created: 1, adopted: 0, released: 0, skipped: 2, failed: 1 });
    const posts = target.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      `/api/models/${encodeURIComponent(GPT_LIVE)}/voices/en-GB`,
      `/api/models/${encodeURIComponent(GPT_LIVE)}/voices/en-GB`,
    ]);
    expect(posts[0].body).toEqual({
      visibility: 'platform', name: 'Fresh', prompt: 'A warm voice.', scriptHint: 'Hello there', gender: 'female', vendor: 'openai',
    });
    expect(target.polls.get('new-2')).toBe(2);
    expect(lines.join('\n')).toMatch(/Existing: skipped, already a platform voice/);
    expect(lines.join('\n')).toMatch(/Rejected: failed: OpenAI rejected the voice/);
    expect(lines.join('\n')).toMatch(/Retired: skipped, withdrawn/);
    // No source key needed, and the source is never called.
  });

  test('fails before any create when the target serves none of a voice\'s models', async () => {
    const target = stubServer({ models: ['pipecat:openai/gpt-realtime'] });
    const data = { source: SOURCE, voices: [{ ...voice({ name: 'Fresh' }), vendorVoiceId: 'voice_f', withdrawn: false }] };
    await expect(run({ data, fetchImpl: fetchFor({ [TARGET]: target }) })).rejects.toThrow(/serves no model for: Fresh/);
    expect(target.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('adopts the vendor voice, then releases it on the source; a re-run repairs a missed release', async () => {
    const source = stubServer({ voices: [voice({ id: 's-1', name: 'One' }), voice({ id: 's-2', name: 'Two' })] });
    const target = stubServer({ vendorIds: ['voice_One', 'voice_Two'] });
    const data = await exportVoices({ api: SOURCE, key: 'key-source', fetchImpl: fetchFor({ [SOURCE]: source }) });

    // The release of Two fails, as if the source were briefly down.
    const flaky = fetchFor({ [SOURCE]: source, [TARGET]: target });
    let failRelease = true;
    const fetchImpl = async (url, init) => {
      if (failRelease && init.method === 'PATCH' && url.endsWith('/s-2')) return { ok: false, status: 503, json: async () => ({ message: 'busy' }) };
      return flaky(url, init);
    };
    const first = await run({ data, adopt: true, sourceKey: 'key-source', fetchImpl });
    expect(first.summary).toEqual({ created: 0, adopted: 2, released: 1, skipped: 0, failed: 1 });
    const posts = target.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.body)).toEqual([
      expect.objectContaining({ visibility: 'platform', name: 'One', vendorVoiceId: 'voice_One', adoptedFrom: SOURCE }),
      expect.objectContaining({ visibility: 'platform', name: 'Two', vendorVoiceId: 'voice_Two', adoptedFrom: SOURCE }),
    ]);
    // Adopted voices are ready at once: no polling.
    expect(target.polls.size).toBe(0);
    // The failed release of Two never reached the source stub.
    expect(source.calls.filter((c) => c.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/api/custom-voices/s-1', body: { release: { to: TARGET } } },
    ]);
    expect(source.voices.map((v) => v.ownership.state)).toEqual(['released', 'owner']);
    expect(first.lines.join('\n')).toMatch(/Two: not released on https:\/\/source\.example.*Run again/);

    // The re-run from the same file: the target already has both, so nothing is
    // adopted again and both are released (a second release is a no-op there).
    failRelease = false;
    const second = await run({ data, adopt: true, sourceKey: 'key-source', fetchImpl });
    expect(second.summary).toEqual({ created: 0, adopted: 0, released: 2, skipped: 0, failed: 0 });
    expect(target.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(source.voices.map((v) => v.ownership.state)).toEqual(['released', 'released']);
    expect(second.lines.join('\n')).toMatch(/Two: https:\/\/target\.example already has voice_Two/);
  });

  test('says to recreate when the target cannot use the vendor voice', async () => {
    const source = stubServer({ voices: [voice({ id: 's-1', name: 'One' })] });
    const target = stubServer({ vendorIds: [] });
    const data = await exportVoices({ api: SOURCE, key: 'key-source', fetchImpl: fetchFor({ [SOURCE]: source }) });
    const { summary, lines } = await run({ data, adopt: true, sourceKey: 'key-source', fetchImpl: fetchFor({ [SOURCE]: source, [TARGET]: target }) });
    expect(summary).toMatchObject({ adopted: 0, released: 0, failed: 1 });
    expect(lines.join('\n')).toMatch(/One: .*cannot use voice_One.*import without --adopt/);
    expect(source.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  test('--only imports one voice, and --adopt needs the source key', async () => {
    const target = stubServer();
    const data = {
      source: SOURCE,
      voices: ['A', 'B'].map((name) => ({ ...voice({ name }), vendorVoiceId: `voice_${name}`, withdrawn: false, ownership: 'owner' })),
    };
    const { summary } = await run({ data, only: 'B', fetchImpl: fetchFor({ [TARGET]: target }) });
    expect(summary.created).toBe(1);
    expect(target.calls.filter((c) => c.method === 'POST').map((c) => c.body.name)).toEqual(['B']);
    await expect(run({ data, only: 'C', fetchImpl: fetchFor({ [TARGET]: target }) })).rejects.toThrow(/No voice named C/);
    await expect(run({ data, adopt: true, fetchImpl: fetchFor({ [TARGET]: target }) })).rejects.toThrow(/--source-key/);
  });
});
