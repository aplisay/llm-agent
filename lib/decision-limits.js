/**
 * Save-time rules for decision-kind models (docs/typesafe-jev.md): pinned
 * ids only, one `result` function whose schema the model can answer, no tool
 * loop, and no voice options. `options.decision` is accepted here and nowhere
 * else. Pure, so lib/database.js can call it inside the model validator.
 */
import Typesafe from './models/typesafe.js';
import {
  functionList,
  resultFunctions,
  questionsFromResultFunction,
  DecisionSchemaError,
} from './decision-questions.js';

/** Providers whose driver class declares `static kind = 'decision'`. */
const DECISION_IMPLEMENTATIONS = [Typesafe];

/** Agent options that mean nothing on a model with no voice and no conversation. */
export const DECISION_REJECTED_OPTIONS = ['tts', 'stt', 'greeting', 'fallback', 'inactivity', 'callHook'];

// The grammar of Handler.parseName (lib/handlers/handler.js): any number of
// `handler:` prefixes, the last one counts, and the provider is matched as
// typed against the lowercased class name. Copied, not imported, because
// handler.js loads the database.
const MODEL_NAME = /^(?:([a-z0-9_-]*):)*([^/]+)\/(.+)$/;

function parseModelName(modelName) {
  const match = MODEL_NAME.exec(String(modelName || ''));
  if (!match) return null;
  const [, handler, provider, model] = match;
  return { handler, provider, model };
}

function implementationFor(modelName) {
  const parsed = parseModelName(modelName);
  if (!parsed) return null;
  return DECISION_IMPLEMENTATIONS.find((impl) => impl.name.toLowerCase() === parsed.provider
    || impl.aliases?.some((alias) => alias.toLowerCase() === parsed.provider)) || null;
}

/** True when the platform would run this model on a decision driver, whatever the roster says. */
export function isDecisionModelName(modelName) {
  return implementationFor(modelName) !== null;
}

/**
 * @param {string} modelName
 * @returns {'decision'|'generative'}
 */
export function modelKind(modelName) {
  return isDecisionModelName(modelName) ? 'decision' : 'generative';
}

/** True when the id is a roster row of its decision driver (`jev-latest` is not). */
export function decisionModelOffered(modelName) {
  const Implementation = implementationFor(modelName);
  return !!(Implementation && Implementation.isOffered(parseModelName(modelName).model));
}

function validateDecisionOptions(decision) {
  if (decision === undefined || decision === null) return;
  if (typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('options.decision must be an object ({ minConfidence })');
  }
  const unknown = Object.keys(decision).filter((key) => key !== 'minConfidence');
  if (unknown.length) {
    throw new Error(`options.decision has unknown field(s) ${unknown.join(', ')} (allowed: minConfidence)`);
  }
  const { minConfidence } = decision;
  if (minConfidence !== undefined && minConfidence !== null
    && (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    throw new Error('options.decision.minConfidence must be a number between 0 and 1');
  }
}

/**
 * Throw when a decision-kind agent breaks the rules above, or when any other
 * agent carries `options.decision`. No-op otherwise.
 *
 * @param {{ modelName: string, functions?: object|unknown[], options?: object, mcpServers?: unknown[] }} agent
 */
export function validateDecisionAgent({ modelName, functions, options, mcpServers }) {
  const Implementation = implementationFor(modelName);
  if (!Implementation) {
    if (options?.decision !== undefined && options?.decision !== null) {
      throw new Error(`options.decision is accepted only on decision models (text:${Typesafe.provider}/...), not on ${modelName}`);
    }
    return;
  }
  const parsed = parseModelName(modelName);
  const offered = Implementation.allModels.map(([id]) => `text:${id}`);
  if (parsed.handler !== 'text') {
    throw new Error(`${modelName}: decision models are text agents; use ${offered.join(' or ')}`);
  }
  if (!Implementation.isOffered(parsed.model)) {
    throw new Error(`${modelName} is not an offered decision model: pinned ids only (${offered.join(', ')}), aliases such as jev-latest are not rows`);
  }
  const list = functionList(functions);
  const results = resultFunctions(list);
  const others = list.filter((f) => !results.includes(f));
  if (others.length) {
    throw new Error(
      `a decision model has no tool loop: ${modelName} accepts only one builtin function with platform "result" `
      + `(remove ${others.map((f) => `"${f.name}"`).join(', ')})`);
  }
  if (results.length !== 1) {
    throw new Error(
      `a decision model needs exactly one builtin function with platform "result" whose properties are the questions it answers `
      + `(${modelName} has ${results.length})`);
  }
  if (Array.isArray(mcpServers) && mcpServers.length) {
    throw new Error(`a decision model has no tool loop: mcpServers are not accepted on ${modelName}`);
  }
  try {
    questionsFromResultFunction(results[0]);
  } catch (e) {
    if (e instanceof DecisionSchemaError) {
      throw new Error(`result function "${results[0].name}": ${e.message}`);
    }
    throw e;
  }
  for (const key of DECISION_REJECTED_OPTIONS) {
    if (options?.[key] !== undefined && options?.[key] !== null) {
      throw new Error(`options.${key} is not accepted on a decision model (${modelName} has no voice and no conversation)`);
    }
  }
  validateDecisionOptions(options?.decision);
}

export default { modelKind, isDecisionModelName, decisionModelOffered, validateDecisionAgent, DECISION_REJECTED_OPTIONS };
