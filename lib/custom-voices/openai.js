/**
 * OpenAI custom voices (docs/custom-voices.md).
 *
 * Only the prompt method is implemented: `POST /v1/audio/voices` with
 * `type: "prompt"`. OpenAI supports prompt voices on GPT-Live only, not on
 * Realtime or the speech endpoint. The voice lives in the OpenAI project of the
 * key that made it, so the API server and the workers must use keys of the same
 * project. OpenAI has no call to list or delete a voice.
 */

export const OPENAI_API_BASE = 'https://api.openai.com/v1';

/** OpenAI's documented ceiling for `script_hint`. It sets none for `prompt`; ours matches. */
export const OPENAI_PROMPT_MAX_CHARS = 2000;
export const OPENAI_SCRIPT_HINT_MAX_CHARS = 2000;

/** OpenAI's cap on prompt voices per OpenAI organisation, shared by every Aplisay customer. */
export const OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = 100;

const CREATE_TIMEOUT_MS = 60_000;

export class VendorVoiceError extends Error {
  constructor(message, { statusCode = 502, vendorStatus, vendorCode } = {}) {
    super(message);
    this.name = 'VendorVoiceError';
    this.statusCode = statusCode;
    this.vendorStatus = vendorStatus;
    this.vendorCode = vendorCode;
  }
}

export function openaiCustomVoicesConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Map an OpenAI error response onto the status our API returns. A 400 is about
 * the request (for example a prompt that names a real person), so its message is
 * passed on. Anything else is a platform problem the caller cannot fix.
 */
function mapOpenAIError(status, body) {
  const vendorMessage = body?.error?.message || `OpenAI returned HTTP ${status}`;
  const vendorCode = body?.error?.code || body?.error?.type;
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

/**
 * Create a prompt voice. Returns the vendor's voice id and its response body.
 *
 * @param {object} p
 * @param {string} p.name
 * @param {string} p.prompt
 * @param {string} [p.scriptHint]
 * @param {typeof fetch} [p.fetchImpl]
 * @returns {Promise<{ vendorVoiceId: string, vendorData: object }>}
 */
export async function createOpenAIPromptVoice({ name, prompt, scriptHint, fetchImpl = fetch }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new VendorVoiceError('OpenAI custom voices are not configured on this platform', { statusCode: 503 });
  }
  const body = { type: 'prompt', name, prompt, model: 'auto' };
  if (scriptHint) body.script_hint = scriptHint;

  let response;
  try {
    response = await fetchImpl(`${OPENAI_API_BASE}/audio/voices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  }
  catch (err) {
    throw new VendorVoiceError(`OpenAI could not be reached: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message}`,
      { statusCode: 502 });
  }

  let json = null;
  try {
    json = await response.json();
  }
  catch {
    json = null;
  }
  if (!response.ok) throw mapOpenAIError(response.status, json);
  if (!json?.id) {
    throw new VendorVoiceError('OpenAI returned no voice id', { statusCode: 502, vendorStatus: response.status });
  }
  return { vendorVoiceId: json.id, vendorData: json };
}
