import Handler from './handler.js';
import Anthropic from '../models/anthropic.js';
import OpenAi from '../models/openai.js';
import Groq from '../models/groq.js';
import Gemini from '../models/gemini.js';

/**
 * Implements the Handler class for headless `text` type agents.
 *
 * Text agents have no audio session: they are invoked like a function, either by
 * an interactive-audio agent via the builtin `subagent` platform function, or
 * directly via `POST /agents/{agentId}/invoke`. The agent runs a text-only LLM
 * conversation against its prompt/functions and is expected to terminate by
 * calling a builtin `result` platform function whose arguments are returned to
 * the invoker as the work product (see lib/subagent.js).
 *
 * Model names use the standard handler prefix, e.g. `text:openai/gpt-4o`,
 * `text:anthropic/claude-3-5-sonnet-20240620`.
 *
 * @class TextHandler
 * @extends {Handler}
 */
class TextHandler extends Handler {

  static name = 'text';
  static description = 'Headless text agent, invoked as a subagent or via the invoke API';
  static hasTelephony = false;
  static hasWebRTC = false;
  static hasWebSocket = false;
  static hasTransfer = false;
  // A text agent may itself delegate to further text agents (depth limited at runtime)
  static hasSubagent = true;
  static agentType = 'text';

  static get models() {
    return [
      Anthropic, OpenAi, Groq, Gemini
    ];
  }

  // Text agents have no TTS leg
  static voices = {};

  async activate() {
    throw new Error('Text agents cannot listen for calls: invoke them with POST /agents/{agentId}/invoke or a subagent function');
  }
}

export default TextHandler;
