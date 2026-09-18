/**
 * Sender personas ("brands") for the outbound auth emails.
 *
 * The verification and password-reset emails are the only two this service
 * composes itself, and they are the only two a deployment cannot re-word
 * without a code change — which is wrong for a shared, generic service: the
 * front end that ASKED for the email knows whose product the reader thinks
 * they signed up to, and this repo should not.
 *
 * So the caller names a persona per request (`x-email-brand` on the auth
 * endpoint, see email-hooks.js) and the operator supplies the persona table in
 * the environment. Nothing here — sender address, product name, tagline, or
 * the sentences themselves — is compiled in; the built-in copy below is
 * deliberately product-neutral and is what an unconfigured deployment sends.
 *
 * CONFIG (first one set wins; unset = built-in defaults + the client's own
 * EMAIL_FROM_ADDRESS):
 *
 *   EMAIL_BRANDS_FILE   path to a JSON document (mounted Secret/ConfigMap)
 *   EMAIL_BRANDS        the same JSON document, inline
 *
 *   {
 *     "default": "aplisay",                  // persona for un-branded requests
 *     "brands": {
 *       "aplisay":   { "from": "hello@aplisay.com" },
 *       "polite-ai": {
 *         "from": "hello@polite.ai",
 *         "fromName": "polite.ai",
 *         "productName": "polite.ai",
 *         "tagline": "Communication, reimagined.",
 *         "templates": {                     // OPTIONAL, overrides the copy
 *           "verification":   { "subject": "…{{productName}}…", "text": "…{{url}}…" },
 *           "reset-password": { "subject": "…", "text": "…" }
 *         }
 *       }
 *     }
 *   }
 *
 * A persona is an INDEX into this table, never an address: an unrecognised (or
 * forged) `x-email-brand` selects the default persona, so the header can only
 * ever choose between senders the operator already approved. That is why it is
 * not behind the AUTH_PROXY_SECRET gate that `x-client-ip` needs.
 *
 * Misconfiguration NEVER stops the process: a missing file, bad JSON or a
 * persona without a `from` is logged at boot and the built-ins carry on. Email
 * config is not worth refusing to serve the API for, and the built-in path is
 * always safe.
 */
import { readFileSync } from 'node:fs';

// Only these are substituted into operator-supplied templates. No template
// engine, no conditionals: config is trusted-operator input, but a language is
// still a needless surface, and an unknown {{token}} should vanish rather than
// leak its own name into someone's inbox.
const VARS = ['url', 'productName', 'tagline', 'name'];

const KINDS = ['verification', 'reset-password'];

/**
 * The product-neutral built-ins, as FUNCTIONS of the persona rather than
 * template strings: a persona that names no product must read as clean English
 * ("your account"), not as a string with the gaps papered over.
 */
const DEFAULT_COPY = {
  verification: ({ productName, tagline }) => ({
    subject: productName ? `Confirm your ${productName} email address` : 'Confirm your email address',
    text: [
      productName
        ? `Confirm the email address on your ${productName} account by opening this link:`
        : 'Confirm the email address on your account by opening this link:',
      '',
      '{{url}}',
      '',
      "If you didn't request this, you can safely ignore this email.",
      ...(tagline ? ['', `— ${productName || ''}${productName ? ' · ' : ''}${tagline}`] : []),
    ].join('\n'),
  }),
  'reset-password': ({ productName, tagline }) => ({
    subject: productName ? `Set your ${productName} password` : 'Set your password',
    text: [
      productName
        ? `Open this link to set your ${productName} password:`
        : 'Open this link to set your password:',
      '',
      '{{url}}',
      '',
      "If you didn't request this, you can safely ignore this email.",
      ...(tagline ? ['', `— ${productName || ''}${productName ? ' · ' : ''}${tagline}`] : []),
    ].join('\n'),
  }),
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Substitute {{var}} for the whitelisted values; anything else is dropped. */
export function render(template, vars) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (
    VARS.includes(key) ? (vars[key] ?? '') : ''
  ));
}

/**
 * Parse the persona table out of the environment. Returns
 * `{ defaultKey, brands }` — `brands` is always an object, empty when nothing
 * is configured (every lookup then falls through to the built-ins).
 */
export function loadBrands(env = process.env, { logger, readFile = readFileSync } = {}) {
  const empty = { defaultKey: null, brands: {} };
  const path = str(env.EMAIL_BRANDS_FILE);
  const inline = str(env.EMAIL_BRANDS);
  if (!path && !inline) return empty;

  let raw;
  try {
    raw = path ? String(readFile(path, 'utf8')) : inline;
  } catch (err) {
    logger?.error({ err: err?.message, path }, 'EMAIL_BRANDS_FILE unreadable — falling back to the built-in sender and copy');
    return empty;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    logger?.error({ err: err?.message, source: path || 'EMAIL_BRANDS' }, 'email brand table is not valid JSON — falling back to the built-in sender and copy');
    return empty;
  }

  const source = doc?.brands;
  if (!source || typeof source !== 'object') {
    logger?.error({ source: path || 'EMAIL_BRANDS' }, 'email brand table has no "brands" object — falling back to the built-in sender and copy');
    return empty;
  }

  const brands = {};
  for (const [key, value] of Object.entries(source)) {
    // `from` is the whole point of a persona; one without it would silently
    // send as somebody else, which is worse than not offering the persona.
    if (!value || typeof value !== 'object' || !str(value.from)) {
      logger?.error({ brand: key }, 'email brand ignored — no "from" address');
      continue;
    }
    const templates = {};
    for (const kind of KINDS) {
      const t = value.templates?.[kind];
      if (t && str(t.subject) && str(t.text)) templates[kind] = { subject: str(t.subject), text: String(t.text) };
      else if (t) logger?.error({ brand: key, kind }, 'email brand template ignored — needs both "subject" and "text"');
    }
    brands[key] = {
      from: str(value.from),
      fromName: str(value.fromName) || undefined,
      productName: str(value.productName) || undefined,
      tagline: str(value.tagline) || undefined,
      templates,
    };
  }

  const defaultKey = str(doc.default) || null;
  if (defaultKey && !brands[defaultKey]) {
    logger?.error({ default: defaultKey }, 'email brand table names an unknown default — un-branded sends use the built-in sender');
    return { defaultKey: null, brands };
  }
  return { defaultKey, brands };
}

/**
 * Resolve a requested persona key. An unknown key is NOT an error the caller
 * can exploit — it lands on the default persona (or on the built-ins), which
 * is the same place an un-branded request lands.
 */
export function resolveBrand(table, key) {
  const brands = table?.brands || {};
  const wanted = str(key);
  if (wanted && brands[wanted]) return brands[wanted];
  if (table?.defaultKey && brands[table.defaultKey]) return brands[table.defaultKey];
  return null;
}

/**
 * Compose the message for one email `kind` in one persona. `from` is omitted
 * when no persona applies, so the email client's own configured default sender
 * (EMAIL_FROM_ADDRESS) still applies exactly as it did before personas existed.
 */
export function composeMessage({ brand, kind, to, url, name }) {
  const persona = brand || {};
  const vars = {
    url,
    name: name || '',
    productName: persona.productName || '',
    tagline: persona.tagline || '',
  };
  const copy = persona.templates?.[kind] || DEFAULT_COPY[kind](persona);
  return {
    ...(persona.from ? { from: { email: persona.from, ...(persona.fromName ? { name: persona.fromName } : {}) } } : {}),
    to,
    subject: render(copy.subject, vars),
    text: render(copy.text, vars),
  };
}

export default loadBrands;
