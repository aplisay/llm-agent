/**
 * `formatted` and the Deepgram pass-through options, accepted in the three STT
 * blocks: `options.stt`, `options.stt.aux` and `options.tts.output`.
 * See docs/stt-formatting.md.
 *
 * The workers map them to each engine (agents/livekit/lib/stt-formatting.ts,
 * agents/pipecat/pipecat_aplisay/stt_formatting.py); the API checks types and
 * refuses the Deepgram options in a block that names another engine.
 */

export const DEEPGRAM_BOOLEAN_OPTIONS = ['smart_format', 'punctuate', 'numerals', 'no_delay'];
export const DEEPGRAM_OPTIONS = [...DEEPGRAM_BOOLEAN_OPTIONS, 'endpointing'];
export const STT_FORMATTING_FIELDS = ['formatted', ...DEEPGRAM_OPTIONS];
export const ENDPOINTING_MIN_MS = 10;
export const ENDPOINTING_MAX_MS = 10000;

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

const isSet = (value) => value !== undefined && value !== null;

/**
 * The engine a `vendor` string names (`deepgram/nova-3:en` → `deepgram`), or
 * undefined when the block names none.
 *
 * @param {unknown} vendor
 * @returns {string | undefined}
 */
export function sttVendorName(vendor) {
  if (typeof vendor !== 'string') return undefined;
  const name = vendor.split(':')[0].split('/')[0].trim().toLowerCase();
  return name || undefined;
}

/**
 * Throw (status 400) when a formatting field in an STT block has the wrong type,
 * or a Deepgram option sits in a block whose vendor is not Deepgram. A block with
 * no vendor uses Deepgram. Not an object: nothing to check.
 *
 * @param {unknown} block options.stt, options.stt.aux or options.tts.output
 * @param {string} context the block's path, for messages
 */
export function validateSttFormatting(block, context = 'options.stt') {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return;
  if (isSet(block.formatted) && typeof block.formatted !== 'boolean') {
    fail(`${context}.formatted must be a boolean`);
  }
  for (const field of DEEPGRAM_BOOLEAN_OPTIONS) {
    if (isSet(block[field]) && typeof block[field] !== 'boolean') {
      fail(`${context}.${field} must be a boolean`);
    }
  }
  const { endpointing } = block;
  if (isSet(endpointing) && endpointing !== false
    && !(Number.isInteger(endpointing) && endpointing >= ENDPOINTING_MIN_MS && endpointing <= ENDPOINTING_MAX_MS)) {
    fail(`${context}.endpointing must be a whole number of milliseconds from ${ENDPOINTING_MIN_MS} to ${ENDPOINTING_MAX_MS}, or false`);
  }
  const deepgramFields = DEEPGRAM_OPTIONS.filter((field) => isSet(block[field]));
  const vendor = sttVendorName(block.vendor);
  if (deepgramFields.length && vendor && vendor !== 'deepgram') {
    fail(`${context} sets ${deepgramFields.join(', ')}, which only Deepgram takes, but its vendor is "${block.vendor}"`);
  }
}
