/**
 * The pure mapping between a decision agent's `result` function and a
 * decision model's question map, and back from the model's answers to the
 * invocation result. Shared by the driver (run time) and by save-time
 * validation so the two can never disagree. See docs/typesafe-jev.md.
 */

/** Result property names the driver fills itself, so a question may not use them. */
export const RESERVED_RESULT_NAMES = ['confidence', 'probabilities', 'decision'];
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 32;
export const MIN_CHOICE_OPTIONS = 2;
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

// Assigning to this key on a plain object sets its prototype instead of a property.
const UNSAFE_NAME = '__proto__';

/** A result schema that a decision model cannot answer. Status 400: the agent definition is wrong. */
export class DecisionSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionSchemaError';
    this.status = 400;
  }
}

/** An answer body that does not fit the questions sent. Status 502: the vendor misbehaved. */
export class DecisionAnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionAnswerError';
    this.status = 502;
  }
}

/** Functions are stored as an array or as an object keyed by name; both shapes are accepted everywhere. */
export function functionList(functions) {
  if (Array.isArray(functions)) return functions.filter(Boolean);
  return Object.entries(functions || {})
    .filter(([, fn]) => fn && typeof fn === 'object')
    .map(([key, fn]) => ({ ...fn, name: fn.name || key }));
}

/** The builtin `result` functions of an agent, in declaration order. */
export function resultFunctions(functions) {
  return functionList(functions).filter((f) => f.implementation === 'builtin' && f.platform === 'result');
}

function describeShape(type) {
  return type === 'string' ? 'a free string' : `type ${JSON.stringify(type)}`;
}

function distinctStrings(name, field, value, min, max) {
  if (!Array.isArray(value)) {
    throw new DecisionSchemaError(`${name}: ${field} must be an array of strings`);
  }
  if (value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new DecisionSchemaError(`${name}: every ${field} entry must be a non-empty string`);
  }
  if (value.includes(UNSAFE_NAME)) {
    throw new DecisionSchemaError(`${name}: "${UNSAFE_NAME}" is not allowed as a ${field} entry`);
  }
  if (new Set(value).size !== value.length) {
    throw new DecisionSchemaError(`${name}: ${field} entries must be distinct`);
  }
  if (value.length < min || value.length > max) {
    throw new DecisionSchemaError(`${name}: ${field} needs between ${min} and ${max} entries (got ${value.length})`);
  }
  return value;
}

function choiceCriteria(name, options, descriptions) {
  const known = new Set(options);
  if (descriptions !== undefined && descriptions !== null) {
    if (typeof descriptions !== 'object' || Array.isArray(descriptions)) {
      throw new DecisionSchemaError(`${name}: x-descriptions must be an object mapping enum values to text`);
    }
    for (const [key, text] of Object.entries(descriptions)) {
      if (!known.has(key)) {
        throw new DecisionSchemaError(`${name}: x-descriptions names "${key}", which is not one of the enum values`);
      }
      if (text !== null && (typeof text !== 'string' || !text.trim())) {
        throw new DecisionSchemaError(`${name}: x-descriptions["${key}"] must be a non-empty string or null`);
      }
    }
  }
  // Every option is a key: the model reads the option list from the criteria map, and an option
  // without a description is interpreted by its name alone (the vendor's documented rule).
  return Object.fromEntries(options.map((option) => [
    option,
    descriptions && Object.hasOwn(descriptions, option) ? descriptions[option] : null,
  ]));
}

function noulCriteria(name, criteria) {
  if (criteria === undefined || criteria === null) return undefined;
  if (typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new DecisionSchemaError(`${name}: x-criteria must be an object with "true" and/or "false" text`);
  }
  const unknown = Object.keys(criteria).filter((key) => key !== 'true' && key !== 'false');
  if (unknown.length) {
    throw new DecisionSchemaError(`${name}: x-criteria accepts only "true" and "false" (found ${unknown.join(', ')})`);
  }
  for (const key of ['true', 'false']) {
    if (criteria[key] !== undefined && (typeof criteria[key] !== 'string' || !criteria[key].trim())) {
      throw new DecisionSchemaError(`${name}: x-criteria["${key}"] must be a non-empty string`);
    }
  }
  const out = Object.fromEntries(['true', 'false'].filter((key) => criteria[key] !== undefined).map((key) => [key, criteria[key]]));
  return Object.keys(out).length ? out : undefined;
}

function rejectExtension(name, property, key, belongsTo) {
  if (property[key] !== undefined && property[key] !== null) {
    throw new DecisionSchemaError(`${name}: ${key} applies to ${belongsTo}, not to this property`);
  }
}

/**
 * One result property to one question. Throws DecisionSchemaError with the
 * fix in the message for anything a decision model cannot answer.
 *
 * @param {string} name the property name
 * @param {object} property the property definition from input_schema.properties
 * @returns {{ type: 'choice'|'noul'|'score', instructions: string, criteria?: object|string[] }}
 */
export function questionFromProperty(name, property) {
  if (RESERVED_RESULT_NAMES.includes(name)) {
    throw new DecisionSchemaError(`${name}: reserved for the result's ${RESERVED_RESULT_NAMES.join(', ')} entries, choose another property name`);
  }
  if (name === UNSAFE_NAME) {
    throw new DecisionSchemaError(`${name}: not allowed as a property name`);
  }
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    throw new DecisionSchemaError(`${name}: the property definition must be an object`);
  }
  if (property.source !== undefined && property.source !== 'generated') {
    throw new DecisionSchemaError(`${name}: a decision model answers every property itself, so source must be "generated" or omitted (got "${property.source}")`);
  }
  const description = typeof property.description === 'string' ? property.description.trim() : '';
  if (!description) {
    throw new DecisionSchemaError(`${name}: a description is required, it is the question the model answers`);
  }
  const type = property.type === undefined ? 'string' : property.type;
  const hasEnum = property.enum !== undefined && property.enum !== null;
  const hasLevels = property['x-levels'] !== undefined && property['x-levels'] !== null;
  if (type === 'boolean') {
    if (hasEnum || hasLevels) {
      throw new DecisionSchemaError(`${name}: a boolean (Noul) takes neither enum nor x-levels`);
    }
    rejectExtension(name, property, 'x-descriptions', 'an enum (Choice); a boolean takes x-criteria');
    const criteria = noulCriteria(name, property['x-criteria']);
    return { type: 'noul', instructions: description, ...(criteria ? { criteria } : {}) };
  }
  if (type === 'string' && hasEnum && hasLevels) {
    throw new DecisionSchemaError(`${name}: enum (Choice) and x-levels (Score) cannot both be set`);
  }
  if (type === 'string' && hasEnum) {
    rejectExtension(name, property, 'x-criteria', 'a boolean (Noul); an enum takes x-descriptions');
    const options = distinctStrings(name, 'enum', property.enum, MIN_CHOICE_OPTIONS, MAX_CHOICE_OPTIONS);
    return { type: 'choice', instructions: description, criteria: choiceCriteria(name, options, property['x-descriptions']) };
  }
  if (type === 'string' && hasLevels) {
    rejectExtension(name, property, 'x-descriptions', 'an enum (Choice)');
    rejectExtension(name, property, 'x-criteria', 'a boolean (Noul)');
    const levels = distinctStrings(name, 'x-levels', property['x-levels'], MIN_SCORE_LEVELS, MAX_SCORE_LEVELS);
    return { type: 'score', instructions: description, criteria: levels };
  }
  throw new DecisionSchemaError(
    `${name}: a decision model can answer an enum (Choice), a boolean (Noul) or x-levels (Score); ${describeShape(type)} is not answerable`);
}

/**
 * The question map for a `result` function: one question per property, in
 * declaration order, keyed by property name.
 *
 * @param {object} fn a builtin function with platform "result"
 * @returns {Record<string, object>}
 */
export function questionsFromResultFunction(fn) {
  const properties = fn?.input_schema?.properties;
  const label = fn?.name || 'result';
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new DecisionSchemaError(`${label}: the result function needs input_schema.properties, one property per question`);
  }
  const entries = Object.entries(properties);
  if (entries.length < MIN_QUESTIONS || entries.length > MAX_QUESTIONS) {
    throw new DecisionSchemaError(`${label}: a decision model answers between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} properties (got ${entries.length})`);
  }
  return Object.fromEntries(entries.map(([name, property]) => [name, questionFromProperty(name, property)]));
}

function numberOr(name, field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DecisionAnswerError(`the decision model returned no numeric ${field} for "${name}"`);
  }
  return value;
}

/** The answer's distribution restricted to `keys`, every one required, in that order. */
function distribution(name, value, keys, describe) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecisionAnswerError(`the decision model returned no probabilities for "${name}"`);
  }
  const out = {};
  keys.forEach((key, index) => {
    if (!Object.hasOwn(value, key)) {
      throw new DecisionAnswerError(`the decision model returned no probability for ${describe(key, index)} of "${name}"`);
    }
    out[key] = numberOr(name, `probability of ${describe(key, index)}`, value[key]);
  });
  return out;
}

/**
 * The invocation result for a set of answers (docs/typesafe-jev.md, "The result").
 * Score levels are named from the question's own level list, not the vendor's
 * legend, so the keys are always the declared names.
 *
 * @param {object} answers the vendor's answers map
 * @param {object} questions the question map the answers are for
 * @param {{ minConfidence?: number }} [decision] options.decision
 */
export function resultFromAnswers(answers, questions, decision = undefined) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new DecisionAnswerError('the decision model returned no answers');
  }
  const minConfidence = typeof decision?.minConfidence === 'number' ? decision.minConfidence : undefined;
  const values = {};
  const confidence = {};
  const probabilities = {};
  let review = false;
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer || typeof answer !== 'object') {
      throw new DecisionAnswerError(`the decision model returned no answer for "${name}"`);
    }
    if (answer.type !== question.type) {
      throw new DecisionAnswerError(`the decision model answered "${name}" as ${JSON.stringify(answer.type)}, expected ${question.type}`);
    }
    if (question.type === 'noul') {
      values[name] = numberOr(name, 'noul', answer.noul);
      continue;
    }
    const answerConfidence = numberOr(name, 'confidence', answer.confidence);
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new DecisionAnswerError(`the decision model chose ${JSON.stringify(answer.choice)} for "${name}", which is not an option`);
      }
      values[name] = answer.choice;
      probabilities[name] = distribution(name, answer.probabilities, options, (option) => `option "${option}"`);
    } else {
      const levels = question.criteria;
      const byIndex = distribution(name, answer.probabilities, levels.map((_, index) => String(index)),
        (key, index) => `level ${key} ("${levels[index]}")`);
      const byName = {};
      let best = null;
      let bestProbability = -Infinity;
      levels.forEach((level, index) => {
        const p = byIndex[String(index)];
        byName[level] = p;
        if (p > bestProbability) {
          bestProbability = p;
          best = level;
        }
      });
      values[name] = best;
      probabilities[name] = byName;
    }
    confidence[name] = answerConfidence;
    if (minConfidence !== undefined && answerConfidence < minConfidence) {
      values[name] = null;
      review = true;
    }
  }
  return {
    ...values,
    confidence,
    probabilities,
    ...(minConfidence !== undefined ? { decision: review ? 'review' : 'auto' } : {}),
  };
}

export default { questionsFromResultFunction, questionFromProperty, resultFromAnswers, resultFunctions, functionList };
