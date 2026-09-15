/**
 * The answer choices of an `ask_user`, as the STRINGS the tool declares
 * (`options: { items: { type: 'string' } }`).
 *
 * The model's raw tool input used to reach the wire with only an
 * Array.isArray check on it, and models routinely answer a choice tool with
 * rich options instead — `[{ label, description }, …]`. Clients then had
 * objects where the schema promised strings: polite.ai's composer handed one
 * to React and the whole builder page died on it (2026-09-15), and the line
 * this session records in its own transcript read "(options: [object
 * Object])", which is what the model reads back when it resumes.
 *
 * Keep the choice rather than drop it: an object contributes its `label` (or
 * the other names a model reaches for), and only something with no usable
 * text goes.
 *
 * Its own module so it can be imported without lib/text-chat.js, which opens
 * a database connection on import.
 */
export function askOptions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const o of value) {
    if (typeof o === 'string') {
      if (o) out.push(o);
      continue;
    }
    if (o && typeof o === 'object') {
      const text = [o.label, o.value, o.name, o.text, o.title].find((v) => typeof v === 'string' && v);
      if (text) out.push(text);
    }
  }
  return out;
}
