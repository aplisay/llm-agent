/**
 * Forms of a caught error for an API answer body and for a log entry. Both copy
 * fields by name and do not copy the error object.
 */

const isErrorLike = (err) => Boolean(err) && typeof err === 'object' && typeof err.message === 'string';

export function isHttpClientError(err) {
  if (!isErrorLike(err)) return false;
  if (err.isAxiosError === true) return true;
  return [err.config, err.request, err.response].some((part) => part && typeof part === 'object');
}

export function isValidationError(err) {
  return isErrorLike(err)
    && (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError')
    && Array.isArray(err.errors);
}

const validationItems = (err) => err.errors.map((item) => ({ message: item?.message, path: item?.path }));

/** The body of a 5xx answer. It never carries the caught error's message. */
export function internalErrorBody() {
  return { message: 'Internal server error' };
}

/**
 * The body of a 4xx answer: `{ message, errors: [{ message, path }] }` for a
 * validation error, and `{ message: fallback }` for anything else.
 */
export function errorBody(err, fallback) {
  if (isValidationError(err)) return { message: err.message, errors: validationItems(err) };
  return { message: fallback };
}

/** Method, and the URL's origin and path only, of the request an HTTP client error describes. */
function requestSummary(err) {
  const config = err.config && typeof err.config === 'object' ? err.config : {};
  const out = {};
  if (typeof config.method === 'string') out.method = config.method.toUpperCase();
  if (typeof config.url === 'string') {
    // Joined as axios joins them: a leading slash in `url` does not replace the path of `baseURL`.
    const joined = typeof config.baseURL === 'string' && !/^[a-z][a-z\d+.-]*:\/\//i.test(config.url)
      ? `${config.baseURL.replace(/\/+$/, '')}/${config.url.replace(/^\/+/, '')}`
      : config.url;
    try {
      const url = new URL(joined);
      out.url = `${url.origin}${url.pathname}`;
    } catch {
      out.url = joined.split(/[?#]/)[0];
    }
  }
  const status = err.response?.status ?? err.status;
  if (typeof status === 'number') out.status = status;
  return out;
}

const OMIT_FROM_LOG = new Set(['sql']);
const isPrimitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * pino serializer for `err`. Keeps the type, message, stack and the error's own
 * plain fields (name, code, status and the like), the method and URL path of an
 * HTTP client error, and the messages of a validation error. Object fields are
 * left out.
 */
export function errorForLog(err, seen = new Set()) {
  // pino-http hands custom serializers pino's own serialized copy, which keeps the original as `raw`.
  if (isErrorLike(err?.raw)) err = err.raw;
  if (!isErrorLike(err)) return err;
  seen.add(err);
  const out = {
    type: typeof err.constructor === 'function' && err.constructor.name !== 'Object' ? err.constructor.name : err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const [field, value] of Object.entries(err)) {
    if (out[field] === undefined && !OMIT_FROM_LOG.has(field) && isPrimitive(value)) out[field] = value;
  }
  if (out.code === undefined && isPrimitive(err.original?.code)) out.code = err.original.code;
  if (isHttpClientError(err)) Object.assign(out, requestSummary(err));
  if (isValidationError(err)) out.errors = validationItems(err);
  if (isErrorLike(err.cause) && !seen.has(err.cause)) out.cause = errorForLog(err.cause, seen);
  return out;
}
