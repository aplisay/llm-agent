// BYOK driver-injection unit tests (docs/byok.md): each text/ultravox driver
// accepts an optional `apiKey` constructor override — the org key — which must
// win over the platform env key, while its absence leaves platform behaviour
// (including the Anthropic prompt-cache singleton) unchanged. No network:
// nothing here calls a provider — assertions read what each SDK client exposes.
process.env.OPENAI_API_KEY ||= 'platform-openai-key';
process.env.ANTHROPIC_API_KEY ||= 'platform-anthropic-key';
process.env.GOOGLE_API_KEY ||= 'platform-google-key';
process.env.KIMI_KEY ||= 'platform-kimi-key';
process.env.ULTRAVOX_API_KEY ||= 'platform-ultravox-key';

const { default: OpenAi } = await import('../lib/models/openai.js');
const { default: Anthropic } = await import('../lib/models/anthropic.js');
const { default: Gemini } = await import('../lib/models/gemini.js');
const { default: Kimi } = await import('../lib/models/kimi.js');

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const baseArgs = (model) => ({
  logger,
  user: 'test',
  prompt: 'You are a test agent.',
  options: {},
  model,
  modelName: model,
  mcpServers: [],
  keys: [],
});

describe('OpenAi (Responses) apiKey override', () => {
  test('org key wins over the platform env key', () => {
    const byok = new OpenAi({ ...baseArgs('text:openai/gpt-5.6-terra'), apiKey: 'org-openai-key' });
    expect(byok.client.apiKey).toBe('org-openai-key');
  });

  test('no override keeps the platform key and client options', () => {
    const platform = new OpenAi(baseArgs('text:openai/gpt-5.6-terra'));
    expect(platform.client.apiKey).toBe(process.env.OPENAI_API_KEY);
    expect(platform.client.maxRetries).toBe(1);
  });

  test('override preserves timeout/maxRetries options', () => {
    const platform = new OpenAi(baseArgs('text:openai/gpt-5.6-terra'));
    const byok = new OpenAi({ ...baseArgs('text:openai/gpt-5.6-terra'), apiKey: 'org-openai-key' });
    expect(byok.client.maxRetries).toBe(platform.client.maxRetries);
    expect(byok.client.timeout).toBe(platform.client.timeout);
  });
});

describe('Anthropic per-instance vs singleton client selection', () => {
  test('platform instances share the module singleton (prompt-cache behaviour)', () => {
    const a = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    const b = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    expect(a.client).toBe(b.client);
    expect(a.client.apiKey).toBe(process.env.ANTHROPIC_API_KEY);
  });

  test('an org key gets its own per-instance client with the same timeout/retry opts', () => {
    const platform = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    const byok = new Anthropic({ ...baseArgs('text:anthropic/claude-sonnet-5'), apiKey: 'org-anthropic-key' });
    expect(byok.client).not.toBe(platform.client);
    expect(byok.client.apiKey).toBe('org-anthropic-key');
    expect(byok.client.timeout).toBe(platform.client.timeout);
    expect(byok.client.maxRetries).toBe(platform.client.maxRetries);
    // The singleton must not have been touched by the BYOK construction.
    expect(platform.client.apiKey).toBe(process.env.ANTHROPIC_API_KEY);
  });
});

describe('Gemini apiKey override', () => {
  test('org key wins over the platform env key', () => {
    const byok = new Gemini({ ...baseArgs('text:google/gemini-2.5-flash'), apiKey: 'org-google-key' });
    expect(byok.ai.apiKey).toBe('org-google-key');
  });

  test('no override keeps the platform key', () => {
    const platform = new Gemini(baseArgs('text:google/gemini-2.5-flash'));
    expect(platform.ai.apiKey).toBe(process.env.GOOGLE_API_KEY);
  });
});

describe('openai-compatible apiKey override and fail-closed throw', () => {
  test('org key wins over the provider env var', () => {
    const byok = new Kimi({ ...baseArgs('text:kimi/kimi-k2.6'), apiKey: 'org-kimi-key' });
    expect(byok.client.apiKey).toBe('org-kimi-key');
    expect(byok.client.baseURL).toBe(Kimi.baseURL);
  });

  test('no override keeps the provider env key', () => {
    const platform = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    expect(platform.client.apiKey).toBe(process.env.KIMI_KEY);
  });

  test('still throws with neither key (never falls back to OPENAI_API_KEY)', () => {
    const saved = process.env.KIMI_KEY;
    delete process.env.KIMI_KEY;
    try {
      expect(() => new Kimi(baseArgs('text:kimi/kimi-k2.6'))).toThrow('KIMI_KEY is not set');
    } finally {
      process.env.KIMI_KEY = saved;
    }
  });

  test('an org key alone is sufficient when the env var is unset', () => {
    const saved = process.env.KIMI_KEY;
    delete process.env.KIMI_KEY;
    try {
      const byok = new Kimi({ ...baseArgs('text:kimi/kimi-k2.6'), apiKey: 'org-kimi-key' });
      expect(byok.client.apiKey).toBe('org-kimi-key');
    } finally {
      process.env.KIMI_KEY = saved;
    }
  });
});

// Ultravox BYOK is handler-side (lib/handlers/ultravox.js ensureOrgApi — a
// per-call client resolved from the org's stored key for join/destroy/
// callEnded), not a model-constructor concern: the Handler base spreads
// agent.dataValues only, so a model-level apiKey would be dead code. The
// handler path needs the database and is exercised by the DB-backed suite
// (tests/organisation-provider-keys.test.mjs covers the resolver it uses).
