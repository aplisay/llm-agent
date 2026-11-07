import Llm from './llm.js';

/** The stub model is on only when APLISAY_STUB_MODEL is exactly '1'. */
export function stubModelEnabled(env = process.env) {
  return env.APLISAY_STUB_MODEL === '1';
}

/**
 * A text model that needs no provider key: every turn answers
 * "echo: <the user's text>". It exists so a smoke test can run a chat round
 * trip on a keyless stack. Never set APLISAY_STUB_MODEL in production.
 *
 * @class Stub
 * @extends {Llm}
 */
class Stub extends Llm {
  static handler = 'text';

  static allModels = [
    ['stub/echo', 'Stub model for tests: repeats the input (APLISAY_STUB_MODEL=1)'],
  ];

  // Agents with functions can be created on it; it never calls them.
  static supportsFunctions = () => true;

  static get needKey() {
    return { APLISAY_STUB_MODEL: stubModelEnabled() ? '1' : '' };
  }

  constructor(args) {
    if (!stubModelEnabled()) throw new Error('the stub model needs APLISAY_STUB_MODEL=1');
    super(args);
    this.gpt = { model: 'echo' };
  }

  async rawCompletion(input) {
    return { text: `echo: ${typeof input === 'string' ? input : JSON.stringify(input)}`, calls: [] };
  }

  async callResult() {
    return { text: '', calls: [] };
  }
}

export default Stub;
