/**
 * The call's "current date/time" for the `metadata` builtin (get_metadata).
 *
 * Voice/text models have no idea what day it is — on a 2026-07-24 staging call
 * an Ultravox agent called calendar_list_events with a 2025-06-18 range, over a
 * year in the past. So we expose the current date/time under the metadata key
 * `aplisay.dateTime`: an agent that reasons about dates ("today", "next
 * Tuesday", calendar ranges) calls get_metadata(["aplisay.dateTime"]) and gets
 * ground truth alongside the other call metadata (callerId, calledId, …).
 *
 * Computed live at get_metadata time (not seeded at call start) so it is always
 * current and needs no change to the ~10 scattered call-metadata composition
 * sites — the two `metadata` builtins (this for node + livekit, the Python twin
 * in the pipecat worker) are the single delivery point. The timezone defaults
 * to Europe/London and is overridable per-deployment with AGENT_TIMEZONE.
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
