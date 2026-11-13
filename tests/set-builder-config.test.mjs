import { setBuilderModel, setBuilderMcpUrl, modelProvider, DEFAULT_SET_BUILDER_MODEL } from '../lib/set-builder-config.js';
import { configStatus, featureStatus, formatStatus } from '../lib/config-status.js';

describe('set builder settings', () => {
  test('the model comes from SET_BUILDER_MODEL, with a default', () => {
    expect(setBuilderModel({})).toBe(DEFAULT_SET_BUILDER_MODEL);
    expect(setBuilderModel({ SET_BUILDER_MODEL: 'text:anthropic/claude-x' })).toBe('text:anthropic/claude-x');
  });

  test('the docs channel follows the run mode unless it is set', () => {
    expect(setBuilderMcpUrl({ NODE_ENV: 'production' })).toBe('https://mcp.aplisay.com/mcp');
    expect(setBuilderMcpUrl({})).toBe('https://mcp.aplisay.com/mcp');
    expect(setBuilderMcpUrl({ NODE_ENV: 'staging' })).toBe('https://mcp-next.aplisay.com/mcp');
    expect(setBuilderMcpUrl({ NODE_ENV: 'development' })).toBe('https://mcp-next.aplisay.com/mcp');
    expect(setBuilderMcpUrl({ NODE_ENV: 'production', SET_BUILDER_MCP_URL: 'https://docs.example/mcp' }))
      .toBe('https://docs.example/mcp');
  });

  test('modelProvider reads the provider segment', () => {
    expect(modelProvider('text:openai/gpt-5.6-terra')).toBe('openai');
    expect(modelProvider('livekit:ultravox/ultravox-v0.7')).toBe('ultravox');
    expect(modelProvider('nonsense')).toBe(null);
    expect(modelProvider(undefined)).toBe(null);
  });
});

// Provider state comes from each driver's canLoad, which reads this process's
// keys. CI has real keys, so these tests pass a fixed provider list instead.
const PROVIDERS = [
  { name: 'openai', enabled: false, missing: ['OPENAI_API_KEY'] },
  { name: 'anthropic', enabled: false, missing: ['ANTHROPIC_API_KEY'] },
];

describe('features in the configuration status', () => {
  test('the set builder is off when its provider has no key, and names the variable', () => {
    const features = featureStatus({}, PROVIDERS);
    expect(features.setBuilder).toEqual({
      enabled: false,
      model: DEFAULT_SET_BUILDER_MODEL,
      missing: ['OPENAI_API_KEY'],
    });
    expect(features.accounts).toEqual({ enabled: false });
  });

  test('the set builder is on when its provider has a key', () => {
    const providers = [{ name: 'openai', enabled: true, missing: [] }];
    expect(featureStatus({}, providers).setBuilder).toEqual({ enabled: true, model: DEFAULT_SET_BUILDER_MODEL });
  });

  test('the set builder follows SET_BUILDER_MODEL to another provider', () => {
    const features = featureStatus({ SET_BUILDER_MODEL: 'text:anthropic/claude-x' }, PROVIDERS);
    expect(features.setBuilder.enabled).toBe(false);
    expect(features.setBuilder.missing).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('a provider the status does not list counts as on', () => {
    const features = featureStatus({ SET_BUILDER_MODEL: 'text:stub/echo' }, PROVIDERS);
    expect(features.setBuilder).toEqual({ enabled: true, model: 'text:stub/echo' });
  });

  test('accounts follow BETTER_AUTH_ENABLED', async () => {
    const { features } = await configStatus({ env: { BETTER_AUTH_ENABLED: 'true' } });
    expect(features.accounts).toEqual({ enabled: true });
  });

  test('formatStatus prints the features', async () => {
    const status = await configStatus({ env: {} });
    const text = formatStatus({ ...status, features: featureStatus({}, PROVIDERS) });
    expect(text).toMatch(/Features/);
    expect(text).toMatch(/set builder disabled\s+text:openai\/gpt-5\.6-terra missing OPENAI_API_KEY/);
  });
});
