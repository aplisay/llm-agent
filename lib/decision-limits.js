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

function parseModelName(modelName) {
  const match = /^(?:([a-z0-9_-]+):)?([^/]+)\/(.+)$/i.exec(String(modelName || ''));
  if (!match) return null;
  const [, handler = 'text', provider, model] = match;
  return { handler, provider: provider.toLowerCase(), model };
}

function implementationFor(modelName) {
  const parsed = parseModelName(modelName);
  if (!parsed) return null;
  return DECISION_IMPLEMENTATIONS.find((impl) => impl.name.toLowerCase() === parsed.provider) || null;
}

/**
 * `decision` for a model served by a decision driver, else `generative`.
 * Independent of the roster's key gate, so validation can reject an
 * unlisted `text:typesafe/` id with the right message.
 *
 * @param {string} modelName
 * @returns {'decision'|'generative'}
 */
export function modelKind(modelName) {
  return implementationFor(modelName)?.kind === 'decision' ? 'decision' : 'generative';
}

export function isDecisionModelName(modelName) {
  return modelKind(modelName) === 'decision';
}

/** True when the id is a roster row of its decision driver (`jev-latest` is not). */
export function decisionModelOffered(modelName) {
  const Implementation = implementationFor(modelName);
  const parsed = parseModelName(modelName);
  return !!(Implementation && parsed && Implementation.isOffered(parsed.model));
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
  if (modelKind(modelName) !== 'decision') {
    if (options?.decision !== undefined && options?.decision !== null) {
      throw new Error(`options.decision is accepted only on decision models (text:${Typesafe.provider}/...), not on ${modelName}`);
    }
    return;
  }
  const parsed = parseModelName(modelName);
  const Implementation = implementationFor(modelName);
  const offered = Implementation.allModels.map(([id]) => `text:${id}`);
  if (parsed.handler !== 'text') {
    throw new Error(`${modelName}: decision models are text agents; use ${offered.join(' or ')}`);
  }
  if (!decisionModelOffered(modelName)) {
    throw new Error(`${modelName} is not an offered decision model: pinned ids only (${offered.join(', ')}), aliases such as jev-latest are not rows`);
  }
  const list = functionList(functions);
  const results = resultFunctions(list);
  const others = list.filter((f) => !(f.implementation === 'builtin' && f.platform === 'result'));
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
