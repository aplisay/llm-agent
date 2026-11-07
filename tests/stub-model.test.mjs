// The stub text model (lib/models/stub.js) is for smoke tests only: it must be
// absent from the model list, and unusable, unless APLISAY_STUB_MODEL=1.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import Stub, { stubModelEnabled } from '../lib/models/stub.js';

const logger = { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} };
let TextHandler;
const saved = process.env.APLISAY_STUB_MODEL;

function listed() {
  // availableModels is computed once per process; start afresh for each case.
  TextHandler._availableModels = undefined;
  return TextHandler.availableModels.map((m) => m.name);
}

beforeAll(async () => {
  await setupRealDatabase();
  ({ default: TextHandler } = await import('../lib/handlers/text.js'));
});

afterAll(async () => {
  if (saved === undefined) delete process.env.APLISAY_STUB_MODEL;
  else process.env.APLISAY_STUB_MODEL = saved;
  TextHandler._availableModels = undefined;
  await teardownRealDatabase();
});

describe('stub text model', () => {
  test.each([undefined, '', '0', 'true', 'yes'])('is hidden and unusable when APLISAY_STUB_MODEL is %p', (value) => {
    if (value === undefined) delete process.env.APLISAY_STUB_MODEL;
    else process.env.APLISAY_STUB_MODEL = value;
    expect(stubModelEnabled()).toBe(false);
    expect(listed()).not.toContain('text:stub/echo');
    expect(TextHandler.models).not.toContain(Stub);
    expect(TextHandler.parseName('text:stub/echo').implementation).toBeUndefined();
    expect(() => new Stub({ logger, prompt: 'x', modelName: 'text:stub/echo' })).toThrow(/APLISAY_STUB_MODEL=1/);
  });

  test('is listed and answers when APLISAY_STUB_MODEL=1', async () => {
    process.env.APLISAY_STUB_MODEL = '1';
    expect(listed()).toContain('text:stub/echo');
    expect(TextHandler.parseName('text:stub/echo').implementation).toBe(Stub);
    const llm = new Stub({ logger, prompt: 'x', modelName: 'text:stub/echo' });
    expect(await llm.rawCompletion('hello')).toEqual({ text: 'echo: hello', calls: [] });
    expect(await llm.completion('again')).toMatchObject({ text: 'echo: again' });
  });
});
