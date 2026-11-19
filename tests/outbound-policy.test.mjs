/**
 * The organisation's outbound policy, the parts that need no database
 * (lib/outbound-policy.js), and the narrowing of both default filters.
 */
import {
  classifyDestination, mergePolicy, validateCeiling, ceilingFor, aboveCeiling, effectivePolicy,
  checkDestination, checkLimits, withinHours, periodsAt,
  DEFAULT_CLASSES, PLATFORM_CEILING, POLICY_CODES, LIMIT_CODES, DESTINATION_CLASSES,
} from '../lib/outbound-policy.js';
import {
  DEFAULT_AGENT_OUTBOUND_FILTER, DEFAULT_TRUNK_OUTBOUND_FILTER, filterAllows,
} from '../lib/outbound-filter.js';

// One number of each class. Ofcom's drama ranges where there is one.
const NUMBERS = {
  ukLandline: ['+442079460123', '+441134960123', '+443069990123', '+441184960000'],
  // 07911 0 and 07829 0 sit in ranges the islands share, but are not theirs.
  ukMobile: ['+447700900123', '+447912123456', '+447911012345', '+447829012345'],
  freephone: ['+448081570123', '+448001234567'],
  service: ['+448449790123', '+448712345678'],
  premium: ['+449098790123', '+44118500', '+447012345678', '+447640123456'],
  crownDependencies: [
    '+441481123456', '+441534123456', '+441624123456', '+447624123456', '+447624501234', '+447781123456',
    '+447911123456', '+447700312345', '+447452012345', '+447937123456',
  ],
  international: ['+15550100123', '+33199001234'],
};

describe('narrowing: 070 and 076 are closed in both default filters', () => {
  test('the agent default filter refuses 070 and 076 in every dialled form', () => {
    for (const number of ['07012345678', '+447012345678', '447012345678', '07640123456', '+447640123456', '447640123456']) {
      expect([number, filterAllows(DEFAULT_AGENT_OUTBOUND_FILTER, number)]).toEqual([number, false]);
    }
  });

  test('the trunk default filter refuses 070 and 076', () => {
    for (const number of ['+447012345678', '+447640123456', '+447612345678']) {
      expect([number, filterAllows(DEFAULT_TRUNK_OUTBOUND_FILTER, number)]).toEqual([number, false]);
    }
  });

  test("the Isle of Man's mobiles, 07624, stay open in both default filters", () => {
    for (const number of ['07624123456', '+447624123456', '447624123456']) {
      expect([number, filterAllows(DEFAULT_AGENT_OUTBOUND_FILTER, number)]).toEqual([number, true]);
    }
    expect(filterAllows(DEFAULT_TRUNK_OUTBOUND_FILTER, '+447624123456')).toBe(true);
  });

  test('both still allow other UK landlines and mobiles', () => {
    for (const number of ['02079460123', '+442079460123', '07700900123', '+447700900123', '07123456789', '+447812345678']) {
      expect([number, filterAllows(DEFAULT_AGENT_OUTBOUND_FILTER, number)]).toEqual([number, true]);
    }
    for (const number of ['+442079460123', '+443069990123', '+447700900123', '+447812345678']) {
      expect([number, filterAllows(DEFAULT_TRUNK_OUTBOUND_FILTER, number)]).toEqual([number, true]);
    }
  });
});

describe('destination classes', () => {
  test.each(Object.entries(NUMBERS))('%s', (name, numbers) => {
    for (const number of numbers) expect([number, classifyDestination(number)]).toEqual([number, name]);
  });

  test('0118 is a landline: only the six digits 118xxx are directory enquiries', () => {
    expect(classifyDestination('+441184960000')).toBe('ukLandline');
    expect(classifyDestination('+44118500')).toBe('premium');
    expect(classifyDestination('+44118118')).toBe('premium');
  });

  test('a UK number in no class, and junk, have no class', () => {
    for (const value of ['+445512345678', '+444412345678', '+4412', null, '', '999', 'WebRTC', '447700900123']) {
      expect([value, classifyDestination(value)]).toEqual([value, null]);
    }
  });

  test('the defaults open the first three classes only', () => {
    expect(DEFAULT_CLASSES).toEqual({
      ukLandline: true, ukMobile: true, freephone: true,
      service: false, premium: false, crownDependencies: false, international: false,
    });
  });

  test.each(DESTINATION_CLASSES)('a closed class %s refuses with the class named', (name) => {
    const ceiling = ceilingFor({ classes: Object.fromEntries(DESTINATION_CLASSES.map((c) => [c, true])) });
    const open = effectivePolicy({ classes: Object.fromEntries(DESTINATION_CLASSES.map((c) => [c, true])) }, ceiling);
    const closed = effectivePolicy({ classes: { ...open.classes, [name]: false } }, ceiling);
    const number = NUMBERS[name][0];
    expect(checkDestination(open, { destination: number })).toBeNull();
    expect(checkDestination(closed, { destination: number })).toMatchObject({
      code: POLICY_CODES.destinationClass, destinationClass: name, reason: expect.stringContaining(number),
    });
  });

  test('070 and 076 are refused by default, as premium numbers', () => {
    const effective = effectivePolicy(null, ceilingFor(null));
    for (const number of ['+447012345678', '+447640123456']) {
      expect(checkDestination(effective, { destination: number })).toMatchObject({ code: 'destination_class', destinationClass: 'premium' });
    }
  });

  test('a UK number in no class is refused even when every class is open', () => {
    const all = Object.fromEntries(DESTINATION_CLASSES.map((c) => [c, true]));
    const effective = effectivePolicy({ classes: all }, ceilingFor({ classes: all }));
    expect(checkDestination(effective, { destination: '+445512345678' })).toMatchObject({ code: 'destination_class', destinationClass: null });
  });
});

describe('the ceiling', () => {
  test('a brand with none gets the platform ceiling', () => {
    expect(ceilingFor(null)).toEqual({ ...PLATFORM_CEILING, classes: { ...DEFAULT_CLASSES } });
    expect(ceilingFor('junk')).toEqual(ceilingFor(null));
  });

  test('a brand sets some fields and the rest come from the platform', () => {
    const ceiling = ceilingFor({ classes: { international: true }, callsInProgress: 3 });
    expect(ceiling.classes.international).toBe(true);
    expect(ceiling.classes.ukLandline).toBe(true);
    expect(ceiling.callsInProgress).toBe(3);
    expect(ceiling.callsPerMinute).toBe(PLATFORM_CEILING.callsPerMinute);
  });

  test('a stored field that is not usable takes the platform value, never no limit', () => {
    expect(ceilingFor({ callsInProgress: -1, spendPerDayMicros: 'lots' })).toMatchObject({
      callsInProgress: PLATFORM_CEILING.callsInProgress, spendPerDayMicros: PLATFORM_CEILING.spendPerDayMicros,
    });
  });

  test('the effective policy is the lower of the organisation and the ceiling', () => {
    const ceiling = ceilingFor({ callsInProgress: 4, callsPerMinute: 6 });
    const effective = effectivePolicy({ callsInProgress: 9, callsPerMinute: 2 }, ceiling);
    expect(effective.callsInProgress).toBe(4);
    expect(effective.callsPerMinute).toBe(2);
    expect(effective.spendPerDayMicros).toBe(PLATFORM_CEILING.spendPerDayMicros);
  });

  test('a class is open only when both open it', () => {
    const ceiling = ceilingFor({ classes: { international: false, service: true } });
    const effective = effectivePolicy({ classes: { international: true, service: true, freephone: false } }, ceiling);
    expect(effective.classes).toMatchObject({ international: false, service: true, freephone: false, ukLandline: true });
  });

  test('a change wider than the ceiling is named', () => {
    const ceiling = ceilingFor({ callsInProgress: 4 });
    expect(aboveCeiling({ classes: { international: true } }, ceiling)).toMatchObject({ field: 'classes.international' });
    expect(aboveCeiling({ callsInProgress: 5 }, ceiling)).toMatchObject({ field: 'callsInProgress' });
    expect(aboveCeiling({ callsInProgress: 4, classes: { international: false } }, ceiling)).toBeNull();
    expect(aboveCeiling({ callsInProgress: null }, ceiling)).toBeNull();
  });

  test('a brand ceiling is validated', () => {
    expect(validateCeiling(null)).toBeNull();
    expect(validateCeiling({ classes: { international: true }, spendPerDayMicros: 1_000_000 })).toBeNull();
    expect(validateCeiling({ classes: { mars: true } })).toMatchObject({ field: 'outboundCeiling.classes.mars' });
    expect(validateCeiling({ callsInProgress: 1.5 })).toMatchObject({ field: 'outboundCeiling.callsInProgress' });
    expect(validateCeiling({ other: 1 })).toMatchObject({ field: 'outboundCeiling.other' });
    expect(validateCeiling([])).toMatchObject({ field: 'outboundCeiling' });
  });
});

describe('changing a policy', () => {
  test('only the named fields change, and null goes back to the ceiling', () => {
    const stored = { classes: { international: true }, callsInProgress: 3, callsPerMinute: 2 };
    const { policy } = mergePolicy(stored, { classes: { service: true }, callsInProgress: null });
    expect(policy).toEqual({ classes: { international: true, service: true }, callsPerMinute: 2 });
  });

  test('bad values are refused with the field', () => {
    expect(mergePolicy({}, { classes: { premium: 'yes' } })).toMatchObject({ field: 'classes.premium' });
    expect(mergePolicy({}, { callsInProgress: -1 })).toMatchObject({ field: 'callsInProgress' });
    expect(mergePolicy({}, { spendPerDayMicros: 1.5 })).toMatchObject({ field: 'spendPerDayMicros' });
    expect(mergePolicy({}, { colour: 'red' })).toMatchObject({ field: 'colour' });
    expect(mergePolicy({}, { hours: { days: [8], from: '08:00', to: '18:00' } })).toMatchObject({ field: 'hours.days' });
    expect(mergePolicy({}, { hours: { days: [1], from: '8am', to: '18:00' } })).toMatchObject({ field: 'hours.from' });
    expect(mergePolicy({}, { hours: { days: [1], from: '08:00', to: '18:00', timeZone: 'Mars/Base' } })).toMatchObject({ field: 'hours.timeZone' });
    expect(mergePolicy({}, null)).toMatchObject({ field: 'body' });
  });

  test('an hours rule is stored with its time zone and sorted days', () => {
    const { policy } = mergePolicy({}, { hours: { days: [5, 1, 3], from: '08:00', to: '18:00' } });
    expect(policy.hours).toEqual({ timeZone: 'Europe/London', days: [1, 3, 5], from: '08:00', to: '18:00' });
    expect(mergePolicy(policy, { hours: null }).policy.hours).toBeUndefined();
  });
});

describe('the hours rule', () => {
  const weekdays = { timeZone: 'Europe/London', days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };

  test('inside and outside office hours, in London time', () => {
    // Wednesday 18 November 2026. London is on GMT.
    expect(withinHours(weekdays, new Date('2026-11-18T12:00:00Z'))).toBe(true);
    expect(withinHours(weekdays, new Date('2026-11-18T07:59:00Z'))).toBe(false);
    expect(withinHours(weekdays, new Date('2026-11-18T18:00:00Z'))).toBe(false);
    // Saturday.
    expect(withinHours(weekdays, new Date('2026-11-21T12:00:00Z'))).toBe(false);
    // Summer time: 07:30 UTC is 08:30 in London.
    expect(withinHours(weekdays, new Date('2026-07-15T07:30:00Z'))).toBe(true);
  });

  test('hours that run past midnight belong to the day they start', () => {
    const nights = { timeZone: 'Europe/London', days: [5], from: '22:00', to: '02:00' };
    expect(withinHours(nights, new Date('2026-11-20T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(withinHours(nights, new Date('2026-11-21T01:00:00Z'))).toBe(true); // Saturday 01:00, Friday night
    expect(withinHours(nights, new Date('2026-11-22T01:00:00Z'))).toBe(false); // Sunday 01:00, Saturday night
  });

  test('a refusal outside the hours, and a stored rule that no longer reads closes every hour', () => {
    const ceiling = ceilingFor(null);
    const night = new Date('2026-11-18T03:00:00Z');
    expect(checkDestination(effectivePolicy({ hours: weekdays }, ceiling), { destination: '+442079460123', at: night }))
      .toMatchObject({ code: POLICY_CODES.outsideHours });
    expect(checkDestination(effectivePolicy({ hours: { days: 'weekdays' } }, ceiling), { destination: '+442079460123', at: new Date('2026-11-18T12:00:00Z') }))
      .toMatchObject({ code: POLICY_CODES.outsideHours });
  });

  test('the local day and month, across a clock change', () => {
    // 00:30 on 1 November 2026 in London is 00:30 UTC (GMT).
    expect(periodsAt(new Date('2026-11-01T00:30:00Z'))).toEqual({
      dayStart: new Date('2026-11-01T00:00:00Z'), monthStart: new Date('2026-11-01T00:00:00Z'), day: '2026-11-01',
    });
    // 23:30 UTC on 14 July is 00:30 on 15 July in London (BST).
    expect(periodsAt(new Date('2026-07-14T23:30:00Z'))).toEqual({
      dayStart: new Date('2026-07-14T23:00:00Z'), monthStart: new Date('2026-06-30T23:00:00Z'), day: '2026-07-15',
    });
  });
});

describe('the limits', () => {
  const effective = effectivePolicy(
    { callsInProgress: 2, callsPerMinute: 3, spendPerDayMicros: 5_000_000, spendPerMonthMicros: 20_000_000 },
    ceilingFor(null),
  );
  const under = { callsInProgress: 1, callsLastMinute: 2, spendToday: 4_999_999, spendMonth: 19_000_000 };

  test('under every limit passes', () => {
    expect(checkLimits(effective, under)).toBeNull();
  });

  test.each([
    ['callsInProgress', { callsInProgress: 2 }, 'calls_in_progress_limit'],
    ['callsPerMinute', { callsLastMinute: 3 }, 'calls_per_minute_limit'],
    ['spendPerDayMicros', { spendToday: 5_000_000 }, 'daily_spend_limit'],
    ['spendPerMonthMicros', { spendMonth: 20_000_001 }, 'monthly_spend_limit'],
  ])('reaching %s refuses with its code', (limit, over, code) => {
    const refusal = checkLimits(effective, { ...under, ...over });
    expect(refusal).toMatchObject({ code, limit, value: effective[limit] });
    expect(refusal.reason).toEqual(expect.any(String));
    expect(LIMIT_CODES.has(code)).toBe(true);
  });

  test('a limit of 0 stops every outside call', () => {
    const none = effectivePolicy({ callsInProgress: 0 }, ceilingFor(null));
    expect(checkLimits(none, { ...under, callsInProgress: 0 })).toMatchObject({ code: 'calls_in_progress_limit' });
  });

  test('a count that could not be read fails closed', () => {
    expect(checkLimits(effective, { ...under, spendMonth: undefined })).toMatchObject({ code: POLICY_CODES.unavailable });
    expect(checkLimits(effective, { ...under, callsInProgress: NaN })).toMatchObject({ code: POLICY_CODES.unavailable });
    expect(checkLimits(effective, null)).toMatchObject({ code: POLICY_CODES.unavailable });
  });
});
