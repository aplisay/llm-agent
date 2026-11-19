/**
 * The desk phone models we know. `lines` is how many lines we put on a model.
 * It is never more than the model's SIP identities or the keys on its first page.
 *
 * `identities` and `firstPageKeys` of the D7xx models are from Snom's data
 * sheets. `labelChars` is not yet checked on a real phone. The 710 figures are
 * samples: it is too old to be provisioned.
 */
export const PHONE_MODELS = {
  'snom:D785': { identities: 12, firstPageKeys: 6, lines: 6, labelChars: 12, family: 'd7', supported: true },
  'snom:D735': { identities: 12, firstPageKeys: 8, lines: 8, labelChars: 12, family: 'd7', supported: true },
  'snom:D717': { identities: 6, firstPageKeys: 3, lines: 3, labelChars: 10, family: 'd7', supported: true },
  'snom:D713': { identities: 6, firstPageKeys: 4, lines: 4, labelChars: 10, family: 'd7', supported: true },
  'snom:710': { identities: 4, firstPageKeys: 5, lines: 4, labelChars: 12, family: 'd7', supported: true },
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
 * model the phone reports wins over the one that was typed. An operator's
 * limit on the device can lower it. An outside number has no lines.
 */
export function phoneCapacity(phone, device) {
  if (phone.kind === 'external') return 0;
  if (phone.kind === 'browser') return BROWSER_CAPACITY;
  if (!device) return 0;
  const lines = phoneModel(device.vendor, device.reportedModel || device.model)?.lines ?? 0;
  return device.lineLimit ? Math.min(lines, device.lineLimit) : lines;
}

export function phoneLabelChars(phone, device) {
  if (!device) return 60;
  return phoneModel(device.vendor, device.reportedModel || device.model)?.labelChars ?? 12;
}
