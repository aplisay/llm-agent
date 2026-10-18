/**
 * OpenAI custom voices (docs/custom-voices.md; internals in docs/implementation/custom-voices.md).
 *
 * Only the prompt method is implemented: `POST /v1/audio/voices` with
 * `type: "prompt"`. OpenAI supports prompt voices on GPT-Live only, not on
 * Realtime or the speech endpoint. The voice lives in the OpenAI project of the
 * key that made it, so the API server and the workers must use keys of the same
 * project.
 *
 * `DELETE /v1/audio/voices/{id}` and `GET /v1/audio/voices` are not in OpenAI's
 * reference or SDK, but the API serves them; see "Deleting at OpenAI" in
 * docs/implementation/custom-voices.md.
 */

export const OPENAI_API_BASE = 'https://api.openai.com/v1';

/** OpenAI's documented ceiling for `script_hint`. It sets none for `prompt`; ours matches. */
export const OPENAI_PROMPT_MAX_CHARS = 2000;
export const OPENAI_SCRIPT_HINT_MAX_CHARS = 2000;

/** OpenAI's cap on prompt voices per OpenAI organisation, shared by every Aplisay customer. */
export const OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = 100;

const CREATE_TIMEOUT_MS = 60_000;
const DELETE_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const LIST_MAX_PAGES = 20;

/**
 * The name a voice is given at OpenAI: our row id, so OpenAI's list can say whether
 * an interrupted create made the voice. The customer's own name stays with us.
 */
export function openaiVoiceName(customVoiceId) {
  return `aplisay-${customVoiceId}`;
}

export class VendorVoiceError extends Error {
  /** `unknownOutcome`: no answer came back, so the vendor may have acted anyway. */
  constructor(message, { statusCode = 502, vendorStatus, vendorCode, unknownOutcome = false } = {}) {
    super(message);
    this.name = 'VendorVoiceError';
    this.statusCode = statusCode;
    this.vendorStatus = vendorStatus;
    this.vendorCode = vendorCode;
    this.unknownOutcome = unknownOutcome;
  }
}

export function openaiCustomVoicesConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function vendorDetail(status, body) {
  return {
    vendorStatus: status,
    vendorCode: body?.error?.code || body?.error?.type,
    vendorMessage: body?.error?.message || `OpenAI returned HTTP ${status}`,
  };
}

/**
 * Map an OpenAI error on create onto the status our API returns. A 400 is about
 * the request (for example a prompt that names a real person), so its message is
 * passed on. Anything else is a platform problem the caller cannot fix.
 */
function mapCreateError(status, body) {
  const { vendorCode, vendorMessage } = vendorDetail(status, body);
  if (status === 400 || status === 422) {
    return new VendorVoiceError(`OpenAI rejected the voice: ${vendorMessage}`, { statusCode: 400, vendorStatus: status, vendorCode });
  }
  if (status === 429) {
    return new VendorVoiceError('OpenAI is refusing new voices for now (rate or voice limit); try again later',
      { statusCode: 503, vendorStatus: status, vendorCode });
  }
  // 401/403: wrong key type or scope. 404: custom voice access not enabled on the project.
  return new VendorVoiceError('OpenAI could not create the voice', { statusCode: 502, vendorStatus: status, vendorCode });
}

async function openaiRequest(method, path, { body, timeoutMs }, fetchImpl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new VendorVoiceError('OpenAI custom voices are not configured on this platform', { statusCode: 503 });
  }
  let response;
  try {
    response = await fetchImpl(`${OPENAI_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  catch (err) {
    throw new VendorVoiceError(`OpenAI could not be reached: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message}`,
      { statusCode: 502, unknownOutcome: true });
  }
  let json = null;
  try {
    json = await response.json();
  }
  catch {
    json = null;
  }
  return { response, json };
}

/**
 * Create a prompt voice. Returns the vendor's voice id and its response body.
 *
 * @param {object} p
 * @param {string} p.name the name at OpenAI ({@link openaiVoiceName})
 * @param {string} p.prompt
 * @param {string} [p.scriptHint]
 * @param {typeof fetch} [p.fetchImpl]
 * @returns {Promise<{ vendorVoiceId: string, vendorData: object }>}
 */
export async function createOpenAIPromptVoice({ name, prompt, scriptHint, fetchImpl = fetch }) {
  const body = { type: 'prompt', name, prompt, model: 'auto' };
  if (scriptHint) body.script_hint = scriptHint;
  const { response, json } = await openaiRequest('POST', '/audio/voices', { body, timeoutMs: CREATE_TIMEOUT_MS }, fetchImpl);
  if (!response.ok) throw mapCreateError(response.status, json);
  if (!json?.id) {
    throw new VendorVoiceError('OpenAI returned no voice id', { statusCode: 502, vendorStatus: response.status });
  }
  return { vendorVoiceId: json.id, vendorData: json };
}

/**
 * Find a voice at OpenAI by its name, paging through `GET /v1/audio/voices`.
 *
 * @param {object} p
 * @param {string} p.name
 * @param {typeof fetch} [p.fetchImpl]
 * @returns {Promise<object | null>} OpenAI's voice object, or null when there is none
 */
export async function findOpenAIVoiceByName({ name, fetchImpl = fetch }) {
  let after = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
    const { response, json } = await openaiRequest('GET', `/audio/voices?${query}`, { timeoutMs: LIST_TIMEOUT_MS }, fetchImpl);
    if (!response.ok) {
      throw new VendorVoiceError('OpenAI could not list voices', { statusCode: 502, ...vendorDetail(response.status, json) });
    }
    const found = (json?.data || []).find((v) => v?.name === name);
    if (found) return found;
    if (!json?.has_more || !json?.last_id) return null;
    after = json.last_id;
  }
  throw new VendorVoiceError('OpenAI voice list is longer than expected', { statusCode: 502 });
}

/**
 * Delete a voice at OpenAI. A voice OpenAI no longer has counts as deleted, so a
 * retried or concurrent delete succeeds. Any other failure throws, and the caller
 * keeps the voice.
 *
 * @param {object} p
 * @param {string} p.vendorVoiceId
 * @param {typeof fetch} [p.fetchImpl]
 * @returns {Promise<{ alreadyGone: boolean, vendorData: object | null }>}
 */
export async function deleteOpenAIVoice({ vendorVoiceId, fetchImpl = fetch }) {
  const { response, json } = await openaiRequest(
    'DELETE', `/audio/voices/${encodeURIComponent(vendorVoiceId)}`, { timeoutMs: DELETE_TIMEOUT_MS }, fetchImpl);
  if (response.ok) return { alreadyGone: false, vendorData: json };
  const { vendorCode, vendorMessage } = vendorDetail(response.status, json);
  // Only this message means the voice is gone. A 404 can also mean the project
  // lacks custom voice access, and then the voice is still there.
  if (response.status === 404 && /no voice found/i.test(vendorMessage)) {
    return { alreadyGone: true, vendorData: json };
  }
  if (response.status === 429) {
    throw new VendorVoiceError('OpenAI is busy; try the delete again later',
      { statusCode: 503, vendorStatus: response.status, vendorCode });
  }
  throw new VendorVoiceError('OpenAI could not delete the voice; it has not been deleted',
    { statusCode: 502, vendorStatus: response.status, vendorCode });
}
