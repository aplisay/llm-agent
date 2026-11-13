/**
 * The desk phone models we know. `lines` is how many lines we put on a model.
 * It is never more than the model's SIP identities or the keys on its first page.
 *
 * The figures are samples until each model has been checked on a real phone.
 */
export const PHONE_MODELS = {
  'snom:D785': { identities: 12, firstPageKeys: 12, lines: 12, labelChars: 12, supported: true },
  'snom:D735': { identities: 12, firstPageKeys: 8, lines: 8, labelChars: 12, supported: true },
  'snom:D717': { identities: 6, firstPageKeys: 6, lines: 6, labelChars: 10, supported: true },
  'snom:710': { identities: 4, firstPageKeys: 5, lines: 4, labelChars: 12, supported: true },
};

/** A browser phone shows lines but needs no key for each. */
export const BROWSER_CAPACITY = 50;

/** Snom's MAC address prefixes (lower-case hex). */
export const SNOM_MAC_PREFIXES = ['000413'];

const MODEL_KEYS = new Map(Object.keys(PHONE_MODELS).map((key) => [key.toLowerCase(), key]));

/** The catalogue entry for a vendor and model as typed, or null. */
export function phoneModel(vendor, model) {
  const key = MODEL_KEYS.get(`${String(vendor ?? '').trim()}:${String(model ?? '').trim()}`.toLowerCase());
  return key ? { key, name: key.split(':')[1], ...PHONE_MODELS[key] } : null;
}

/** Twelve lower-case hex digits, or null when the input is not a MAC address. */
export function normaliseMac(raw) {
  const mac = String(raw ?? '').replace(/[\s:.-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(mac) ? mac : null;
}

export function isSnomMac(mac) {
  return SNOM_MAC_PREFIXES.some((prefix) => String(mac).startsWith(prefix));
}

/**
 * How many lines a phone can carry. A desk phone: from its model, and the
 * model the phone reports wins over the one that was typed. An outside number
 * has no lines.
 */
export function phoneCapacity(phone, device) {
  if (phone.kind === 'external') return 0;
  if (phone.kind === 'browser') return BROWSER_CAPACITY;
  if (!device) return 0;
  return phoneModel(device.vendor, device.reportedModel || device.model)?.lines ?? 0;
}

export function phoneLabelChars(phone, device) {
  if (!device) return 60;
  return phoneModel(device.vendor, device.reportedModel || device.model)?.labelChars ?? 12;
}
