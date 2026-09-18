/**
 * Compute aplisay.dateTime at each metadata request so date reasoning stays current across long calls.
 * Keep the Python helper aligned, including the AGENT_TIMEZONE override; see PR #170.
 */

/** The metadata keys that resolve to the live current date/time. */
export function isDateTimeMetadataKey(key) {
  return typeof key === 'string' && /^(aplisay\.)?date[_]?time$/i.test(key.trim());
}

/** IANA timezone the date/time is rendered in (AGENT_TIMEZONE, else Europe/London). */
export function agentTimezone() {
  const tz = (process.env.AGENT_TIMEZONE || '').trim();
  return tz || 'Europe/London';
}

/**
 * A human- and model-readable current date/time string, e.g.
 * "Thursday 2026-07-24 14:05 Europe/London". Carries the weekday (for "next
 * Tuesday" reasoning), an ISO-8601 date (directly usable in calendar ranges),
 * the 24h local time and the zone. `now`/`tz` are injectable for tests.
 */
export function currentDateTimeString(now = new Date(), tz = agentTimezone()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    // Invalid AGENT_TIMEZONE — fall back to UTC rather than throwing mid-call.
    return currentDateTimeString(now, 'UTC');
  }
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour; // some environments emit 24:00
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${hour}:${p.minute} ${tz}`;
}
