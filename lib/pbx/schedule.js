/**
 * Whether a schedule is in force at a moment. Pure. A schedule is
 * `{ always: true }`, or `{ timezone, windows: [{ days: [1..7], from, to }] }`
 * with day 1 as Monday and times as HH:MM in the schedule's time zone. A
 * window whose `to` is not after its `from` runs past midnight, and its days
 * name the day it starts on.
 */

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday (1 = Monday) and minute of the day of `at` in a time zone. */
export function localDayAndMinute(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type)?.value;
  return { day: WEEKDAYS[part('weekday')], minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function scheduleInForce(schedule, at = new Date()) {
  if (!schedule || schedule.always === true) return true;
  if (!schedule.timezone || !Array.isArray(schedule.windows)) return false;
  let local;
  try {
    local = localDayAndMinute(at, schedule.timezone);
  } catch {
    return false;
  }
  const yesterday = local.day === 1 ? 7 : local.day - 1;
  return schedule.windows.some((window) => {
    const from = minutes(window.from);
    const to = minutes(window.to);
    const days = window.days || [];
    if (to > from) return days.includes(local.day) && local.minute >= from && local.minute < to;
    // Past midnight: the late part belongs to the start day, the early part to the day after.
    return (days.includes(local.day) && local.minute >= from) || (days.includes(yesterday) && local.minute < to);
  });
}
