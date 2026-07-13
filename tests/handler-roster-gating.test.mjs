// Handler-level roster gating: a whole handler *family* must drop out of
// `availableModels` (the GET /models roster) when its transport credentials are
// unset, so we can ship a pipecat-only / livekit-only instance. This is distinct
// from the per-model canLoad filter, which gates individual LLM providers on
// their own API keys. `Handler` + the real handler classes pull lib/database.js,
// whose module init calls sequelize.authenticate(); the DB lifecycle below is
// only here to satisfy that import (the assertions themselves are pure).
import { setupRealDatabase, teardownRealDatabase, databaseStarted } from './setup/database-test-wrapper.js';

const Handler = (await import('../lib/handlers/handler.js')).default;

beforeAll(async () => { await setupRealDatabase(); await databaseStarted; }, 30000);
afterAll(async () => { await teardownRealDatabase(); }, 30000);

// A loadable LLM model (its own provider key is present).
class LoadableModel {
  static get canLoad() { return { ok: true }; }
  static allModels = [['openai/gpt-4o', 'Fake GPT-4o']];
  static supportsFunctions = () => true;
  static supportsMcp = () => false;
  static audioModel = false;
}
// An LLM model whose provider key is missing.
class UnloadableModel {
  static get canLoad() { return { ok: false, need: ['SOME_LLM_KEY'] }; }
  static allModels = [['openai/gpt-4o', 'Fake GPT-4o']];
  static supportsFunctions = () => true;
  static supportsMcp = () => false;
  static audioModel = false;
}

describe('handler-level roster gating', () => {
  it('lists models when the handler family credentials are present', () => {
    class Loadable extends Handler {
      static name = 'loadable';
      static needKey = { FAMILY_KEY: 'present' };
      static get models() { return [LoadableModel]; }
    }
    expect(Loadable.availableModels.map((m) => m.name)).toEqual(['loadable:openai/gpt-4o']);
  });

  it('drops the entire family when a handler credential is unset', () => {
    class Unloadable extends Handler {
      static name = 'unloadable';
      // A missing (undefined) value in needKey => canLoad.ok is false.
      static needKey = { FAMILY_KEY: undefined };
      // The model itself would load — proving the *handler* gate, not the model gate.
      static get models() { return [LoadableModel]; }
    }
    expect(Unloadable.availableModels).toEqual([]);
  });

  it('still applies the per-model gate once the handler family loads', () => {
    class HandlerOkModelMissing extends Handler {
      static name = 'partial';
      static needKey = { FAMILY_KEY: 'present' };
      static get models() { return [UnloadableModel]; }
    }
    expect(HandlerOkModelMissing.availableModels).toEqual([]);
  });

  it('leaves keyless handlers (e.g. text) ungated at the family level', () => {
    class Keyless extends Handler {
      static name = 'keyless';
      // No needKey => canLoad.ok is unconditionally true.
      static get models() { return [LoadableModel]; }
    }
    expect(Keyless.availableModels.map((m) => m.name)).toEqual(['keyless:openai/gpt-4o']);
  });
});

// A jambonz-less build (no JAMBONZ_API_KEY) must still import the jambonz handler
// cleanly — handlers() imports it unconditionally, so a module-load throw there
// would take down GET /models, /voices and everything else. Env is controlled
// here (and captured at handler module-eval time) so the assertion is
// deterministic regardless of the ambient CI keys; the guarded voices IIFE means
// no live Jambonz API call fires, keeping the test hermetic.
describe('jambonz-less build: handler stays import-safe and gated out', () => {
  const saved = {
    key: process.env.JAMBONZ_API_KEY,
    server: process.env.JAMBONZ_SERVER,
  };
  beforeAll(() => {
    delete process.env.JAMBONZ_API_KEY;
    delete process.env.JAMBONZ_SERVER;
  });
  afterAll(() => {
    if (saved.key !== undefined) process.env.JAMBONZ_API_KEY = saved.key;
    if (saved.server !== undefined) process.env.JAMBONZ_SERVER = saved.server;
  });

  it('imports without throwing, offers no models, and yields empty voices', async () => {
    // First import of the module in this file's registry — captures the unset env.
    const JambonzHandler = (await import('../lib/handlers/jambonz.js')).default;
    expect(JambonzHandler.canLoad.ok).toBe(false);
    expect(JambonzHandler.availableModels).toEqual([]);
    await expect(JambonzHandler.voices).resolves.toEqual({});
  });
});
