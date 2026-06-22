import defaultLogger from './logger.js';
import handlers from './handlers/index.js';
import { functionHandler } from './function-handler.js';

// Hard ceiling on text-agent → text-agent delegation to stop runaway recursion
const MAX_SUBAGENT_DEPTH = 3;
// Maximum LLM round trips (completions) in a single subagent invocation
const DEFAULT_MAX_TURNS = 10;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SubagentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SubagentError';
    this.status = status;
  }
}

/**
 * Build the LLM-facing view of an agent's functions: only `generated`
 * parameters are exposed to the model; `static` and `metadata` parameters are
 * resolved post-dispatch by the function handler (same convention as the
 * voice workers).
 */
export function llmFunctions(functions = []) {
  return functions.map((f) => {
    const properties = Object.fromEntries(
      Object.entries(f.input_schema?.properties || {})
        .filter(([, p]) => !p.source || p.source === 'generated')
        .map(([key, p]) => [key, {
          type: p.type || 'string',
          ...(p.description ? { description: p.description } : {}),
          ...(p.enum ? { enum: p.enum } : {})
        }])
    );
    return {
      name: f.name,
      description: f.description,
      input_schema: {
        type: 'object',
        properties,
        required: Object.entries(f.input_schema?.properties || {})
          .filter(([key, p]) => p.required && properties[key])
          .map(([key]) => key)
      }
    };
  });
}

function buildSystemPrompt(agent, resultNames) {
  const harness = resultNames.length
    ? `You are running headlessly as a subagent: there is no interactive user, so never ask questions or wait for input. ` +
    `Complete the task described in the input, then you MUST deliver your output by calling the \`${resultNames.join('` or `')}\` function exactly once. ` +
    `The arguments you pass to that function are the only output the invoking agent will see.`
    : `You are running headlessly as a subagent: there is no interactive user, so never ask questions or wait for input. ` +
    `Complete the task described in the input and reply with your final output as plain text.`;
  return `${agent.prompt}\n\n${harness}`;
}

function formatTaskInput(input) {
  if (input === undefined || input === null || (typeof input === 'object' && !Object.keys(input).length)) {
    return 'Begin the task now.';
  }
  if (typeof input === 'string') {
    return input;
  }
  return `Task input:\n${JSON.stringify(input, null, 2)}`;
}

/**
 * Run a `text` type agent headlessly until it produces a result.
 *
 * The agent's LLM is given the invocation input as its first user message and
 * runs a normal tool-use loop (rest/stub/builtin functions are dispatched via
 * the shared function handler). The loop terminates when the agent calls one of
 * its builtin `result` platform functions, whose (generated) arguments become
 * the returned result. Agents with no `result` function fall back to returning
 * their first plain-text completion.
 *
 * @param {object} params
 * @param {object} params.agent Agent row (or plain object) of type 'text'
 * @param {object|string} params.input task input (forwarded generated parameters)
 * @param {object} [params.metadata] call metadata made available to the agent's own functions
 * @param {object} [params.logger] pino logger
 * @param {number} [params.maxTurns] LLM round-trip limit
 * @param {number} [params.depth] current subagent nesting depth
 * @param {Function} [params.implementationOverride] LLM implementation class (tests)
 * @returns {Promise<{result: any, complete: boolean, transcript: Array}>}
 */
export async function runSubagent({
  agent,
  input,
  metadata = {},
  logger = defaultLogger,
  maxTurns = DEFAULT_MAX_TURNS,
  depth = 0,
  implementationOverride
}) {
  if ((agent.type || 'interactive-audio') !== 'text') {
    throw new SubagentError(`Agent ${agent.id} is not a text agent and cannot be invoked as a subagent`);
  }
  if (depth > MAX_SUBAGENT_DEPTH) {
    throw new SubagentError(`Maximum subagent nesting depth (${MAX_SUBAGENT_DEPTH}) exceeded`);
  }

  let Implementation = implementationOverride;
  if (!Implementation) {
    const { getHandler } = await handlers();
    const Handler = getHandler(agent.modelName);
    if (!Handler) {
      throw new SubagentError(`Unknown model name: ${agent.modelName}`);
    }
    ({ implementation: Implementation } = Handler.parseName(agent.modelName));
    if (!Implementation) {
      throw new SubagentError(`No LLM implementation available for ${agent.modelName}`);
    }
  }

  // Agent functions are stored either as an array or as an object keyed by name
  const functions = Array.isArray(agent.functions)
    ? agent.functions
    : Object.values(agent.functions || {});
  const resultNames = functions
    .filter((f) => f.implementation === 'builtin' && f.platform === 'result')
    .map((f) => f.name);

  const llm = new Implementation({
    logger,
    user: `subagent-${agent.id}`,
    prompt: buildSystemPrompt(agent, resultNames),
    functions: llmFunctions(functions),
    keys: agent.keys,
    options: agent.options,
    modelName: agent.modelName,
    model: agent.modelName,
    // Honour the agent's remote MCP servers (the Anthropic MCP connector) — a
    // knowledge subagent's whole purpose. Without this the subagent runs blind
    // to its MCP. (text-chat.js passes this too; this path used to drop it.)
    mcpServers: agent.mcpServers,
  });

  const transcript = [];
  // Token usage accumulated across this invocation, keyed per (agent, provider,
  //  model) so nested subagents (bubbled up via invokeSubagent) keep their own
  //  attribution. The caller (invoke / agent-db subagent endpoints, or the chat
  //  session) owns the session id and records `usage` into the ledger.
  const usageByMeter = new Map();
  const addUsage = (u) => {
    if (!u) return;
    for (const entry of Array.isArray(u) ? u : [u]) {
      if (!entry) continue;
      const agentId = entry.agentId || agent.id;
      const key = `${agentId}|${entry.provider || ''}|${entry.model || ''}`;
      const cur = usageByMeter.get(key)
        || { agentId, provider: entry.provider, model: entry.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      cur.inputTokens += entry.inputTokens || 0;
      cur.outputTokens += entry.outputTokens || 0;
      cur.cacheReadTokens += entry.cacheReadTokens || 0;
      cur.cacheWriteTokens += entry.cacheWriteTokens || 0;
      usageByMeter.set(key, cur);
    }
  };
  const usage = () => [...usageByMeter.values()];

  const functionOptions = {
    // Allow a text agent to delegate to further text agents, depth limited.
    //  Bubble the child's usage up so the top-level caller records the whole tree.
    invokeSubagent: (targetAgentId, args, md) =>
      runSubagentById({ agentId: targetAgentId, input: args, metadata: md || metadata, organisationId: agent.organisationId, logger, depth: depth + 1 })
        .then((r) => { addUsage(r.usage); return r.result; })
  };

  let turn = await llm.completion(formatTaskInput(input));
  addUsage(turn.usage);
  let lastText;

  for (let i = 0; i < maxTurns; i++) {
    const { text, calls, error } = turn;
    if (text) {
      lastText = text;
      transcript.push({ agent: text });
    }
    if (error) {
      throw new SubagentError(`Subagent LLM error: ${typeof error === 'string' ? error : JSON.stringify(error)}`, 502);
    }
    if (calls && calls.length) {
      transcript.push({ function_calls: calls.map(({ name, input: args }) => ({ name, input: args })) });
      const resultCall = calls.find((call) => resultNames.includes(call.name));
      if (resultCall) {
        return { result: resultCall.input ?? {}, complete: true, transcript, usage: usage() };
      }
      const { function_results } = await functionHandler(
        calls, functions, agent.keys || [],
        (message) => { message.function_results && transcript.push(message); },
        metadata, {}, functionOptions);
      turn = await llm.callResult(function_results);
      addUsage(turn.usage);
      continue;
    }
    // No result function defined: first plain text completion is the result
    if (!resultNames.length && lastText) {
      return { result: { text: lastText }, complete: true, transcript, usage: usage() };
    }
    if (i === maxTurns - 1) {
      break;
    }
    // The model stopped without calling its result function: nudge it once per turn
    turn = await llm.completion('Complete the task now. When you have the answer, deliver it by calling your result function.');
    addUsage(turn.usage);
  }

  logger.info({ agentId: agent.id, transcript }, 'subagent reached turn limit without calling result');
  return { result: { text: lastText ?? null }, complete: false, transcript, usage: usage() };
}

/**
 * Load a text agent by id, verify ownership, and run it.
 * `organisationId` (and/or `userId`) must match the agent row: this is the
 * server-side guard that stops one tenant invoking another tenant's agents.
 */
export async function runSubagentById({ agentId, input, metadata, organisationId, userId, logger = defaultLogger, depth = 0, maxTurns, implementationOverride }) {
  if (!agentId || !UUID_REGEX.test(`${agentId}`)) {
    throw new SubagentError(`Invalid subagent target: ${agentId}`);
  }
  // Lazy import so this module stays loadable in contexts without a database
  const { Agent } = await import('./database.js');
  const agent = await Agent.findByPk(agentId);
  if (!agent) {
    throw new SubagentError(`Subagent ${agentId} not found`, 404);
  }
  const ownedByOrganisation = organisationId && agent.organisationId === organisationId;
  const ownedByUser = userId && agent.userId === userId;
  if (!ownedByOrganisation && !ownedByUser) {
    throw new SubagentError(`Subagent ${agentId} not found`, 404);
  }
  return runSubagent({ agent, input, metadata, logger, depth, maxTurns, implementationOverride });
}

export default runSubagent;
