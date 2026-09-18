/**
 * Normalise ask_user choices to strings before emitting or recording them; models may return label objects.
 * Keep this helper independent of database imports; see PR #331.
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
