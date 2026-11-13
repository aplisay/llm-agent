/**
 * A refusal of a phone-system request: an HTTP status, a stable code, a plain
 * sentence, and where useful the field at fault and some detail.
 */
export class PbxError extends Error {
  constructor(status, code, message, { field, detail } = {}) {
    super(message);
    this.name = 'PbxError';
    this.status = status;
    this.code = code;
    if (field !== undefined) this.field = field;
    if (detail !== undefined) this.detail = detail;
  }

  body() {
    return {
      error: this.message,
      code: this.code,
      ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

/** Send a PbxError as its own status and body. Anything else is a 500. */
export function sendPbxError(res, err, log, context = 'phone system request failed') {
  if (err instanceof PbxError) {
    res.status(err.status).send(err.body());
    return;
  }
  log?.error?.(err, context);
  res.status(500).send({ error: 'Internal server error' });
}
