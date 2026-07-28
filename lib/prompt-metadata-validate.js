/**
 * Shape + capability validation for an agent's `promptMetadata` declaration.
 *
 * Runs in the Agent model's validate block, so a malformed declaration is
 * rejected at create/update time rather than silently producing a broken system
 * prompt on a live call. Semantics of the values themselves live in
 * lib/prompt-metadata.js; this module only decides what may be STORED.
 *
 * The `toolsCalls` rule is deliberately identical to the one
 * validateToolsCallsMetadataUsage enforces for `source: "metadata"` parameters
 * and the `metadata` builtin: those paths carry other tools' results and are
 * only available on handlers that opt in (Handler.hasDynamicMetadata — LiveKit).
 * Without this, promptMetadata would be a way around that gate.
 */
import {
  MAX_PROMPT_METADATA_ENTRIES,
  MAX_DESCRIPTION_CHARS,
} from './prompt-metadata.js';

const isToolsCallsPath = (from) =>
  typeof from === 'string' && (from === 'toolsCalls' || from.startsWith('toolsCalls.'));

/** Dot-path of ordinary identifier segments (numeric segments index arrays). */
const PATH_RE = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

/**
 * @param {Object} args
 * @param {Object} args.Handler the resolved handler class for the agent's model
 * @param {*} args.promptMetadata the declaration as supplied
 * @throws {Error} with a message safe to return to the API caller
 */
export function validatePromptMetadata({ Handler, promptMetadata }) {
  if (promptMetadata === undefined || promptMetadata === null) return;

  if (!Array.isArray(promptMetadata)) {
    throw new Error('promptMetadata must be an array of { description, from } entries');
  }
  if (promptMetadata.length > MAX_PROMPT_METADATA_ENTRIES) {
    throw new Error(`promptMetadata may declare at most ${MAX_PROMPT_METADATA_ENTRIES} entries`);
  }

  const allowDynamicMetadata = !!Handler?.hasDynamicMetadata;

  promptMetadata.forEach((entry, index) => {
    const at = `promptMetadata[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} must be an object with a 'from' metadata path`);
    }
    const { from, description } = entry;
    if (typeof from !== 'string' || !from.trim()) {
      throw new Error(`${at}.from is required and must be a metadata path, e.g. 'aplisay.dateTime'`);
    }
    if (!PATH_RE.test(from.trim())) {
      throw new Error(`${at}.from '${from}' is not a valid metadata path`);
    }
    if (!allowDynamicMetadata && isToolsCallsPath(from.trim())) {
      throw new Error('Access to metadata.toolsCalls is only allowed in LiveKit agents');
    }
    if (description !== undefined && description !== null) {
      if (typeof description !== 'string') {
        throw new Error(`${at}.description must be a string`);
      }
      if (description.length > MAX_DESCRIPTION_CHARS) {
        throw new Error(`${at}.description must be ${MAX_DESCRIPTION_CHARS} characters or fewer`);
      }
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'from' && key !== 'description') {
        throw new Error(`${at} has unknown property '${key}' (expected 'description' and 'from')`);
      }
    }
  });
}
