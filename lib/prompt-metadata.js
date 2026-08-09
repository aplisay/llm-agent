/**
 * `promptMetadata` — declare call metadata that is stated to the model IN ITS
 * SYSTEM PROMPT, instead of leaving it to fetch the value with a tool call.
 *
 *   promptMetadata: [
 *     { description: "The current date/time is", from: "aplisay.dateTime" },
 *     { description: "The caller is calling from", from: "aplisay.callerId" }
 *   ]
 *
 * Each entry renders as one `<description> <value>` line appended to the
 * agent's prompt under a short header.
 *
 * WHY, when `get_metadata` already exposes the same values: a tool round-trip
 * only happens if the model REMEMBERS to make it, and on realtime providers it
 * freezes the conversation while it runs. Facts the agent reasons with from its
 * very first utterance — today's date above all — belong in the prompt. Beta
 * 2026-07-27: a booking agent repeatedly computed "next Monday" as a 2025 date
 * and sent it as a slot-search start, because nothing in its context said what
 * day it was.
 *
 * Semantics (identical across the node/ultravox, livekit and pipecat workers —
 * the python twin is agents/pipecat/pipecat_aplisay/prompt_metadata.py):
 *  - `from` is a dot-path into the same call metadata that `source: "metadata"`
 *    function parameters read (getByPath), so `aplisay.callerId`,
 *    `aplisay.calledId`, and any instance metadata the deployment seeds.
 *  - `aplisay.dateTime` is computed live at prompt-composition time, exactly as
 *    the `metadata` builtin does — a seeded value still wins.
 *  - An entry whose value is missing, null or empty is OMITTED, never rendered
 *    as "undefined": an absent optional fact must not become a statement the
 *    model then treats as true.
 *  - Objects/arrays render as compact JSON; every value is length-capped so a
 *    large seeded blob cannot crowd out the prompt.
 *  - An empty/absent `promptMetadata` returns the prompt completely untouched.
 */
import { getByPath } from './metadata-path.js';
import { isDateTimeMetadataKey, currentDateTimeString } from './current-datetime.js';

/** Heading the resolved lines are appended under. */
export const PROMPT_METADATA_HEADING = 'Call context (current facts about this call):';

/** Bounds — also enforced by the model validation, so these are belt and braces. */
export const MAX_PROMPT_METADATA_ENTRIES = 20;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_VALUE_CHARS = 500;

/** Render one resolved value as prompt text, or null when it carries nothing. */
function renderValue(value) {
  if (value === undefined || value === null) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  text = text.trim();
  if (!text) return null;
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * Resolve `promptMetadata` against a call's metadata into rendered lines.
 * Exported for tests and for workers that want the lines without the prompt.
 *
 * @param {Array<{description?: string, from: string}>} [promptMetadata]
 * @param {Object} [metadata] the call metadata object
 * @returns {string[]} one line per entry that resolved to a value
 */
export function resolvePromptMetadataLines(promptMetadata, metadata) {
  if (!Array.isArray(promptMetadata) || promptMetadata.length === 0) return [];
  const lines = [];
  for (const entry of promptMetadata.slice(0, MAX_PROMPT_METADATA_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue;
    const from = typeof entry.from === 'string' ? entry.from.trim() : '';
    if (!from) continue;

    let value = getByPath(metadata, from);
    // Live clock, same rule as the `metadata` builtin: a seeded value wins.
    if ((value === undefined || value === null) && isDateTimeMetadataKey(from)) {
      value = currentDateTimeString();
    }
    const rendered = renderValue(value);
    if (rendered === null) continue;

    const description =
      typeof entry.description === 'string' ? entry.description.trim().slice(0, MAX_DESCRIPTION_CHARS) : '';
    lines.push(description ? `${description} ${rendered}` : rendered);
  }
  return lines;
}

/**
 * The agent's prompt with its resolved `promptMetadata` appended.
 * Returns `prompt` unchanged when nothing resolves, so an agent without the
 * feature — or one whose values are all absent — is byte-identical to before.
 *
 * @param {string} [prompt] the agent's own system prompt
 * @param {Array<{description?: string, from: string}>} [promptMetadata] the agent's declaration
 * @param {Object} [metadata] the call metadata
 * @returns {string}
 */
export function promptWithMetadata(prompt, promptMetadata, metadata) {
  const lines = resolvePromptMetadataLines(promptMetadata, metadata);
  if (lines.length === 0) return prompt;
  const base = typeof prompt === 'string' ? prompt : '';
  const block = `${PROMPT_METADATA_HEADING}\n${lines.join('\n')}`;
  return base.trim() ? `${base.trimEnd()}\n\n${block}` : block;
}
