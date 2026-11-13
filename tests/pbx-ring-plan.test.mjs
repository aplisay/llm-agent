/**
 * The ring plan and the pure helpers it uses. No database.
 *
 * The fixture is a small office: Rob (100), Priya (101) and Ellie (102), and
 * a Sales team (200) with all three as members. Line keys are worked out
 * with workOutLines, the same way the reconciler does it.
 */
import { buildRingPlan, MAX_HOPS } from '../lib/pbx/ring-plan.js';
import { indexSnapshot, linesInput, shownNumber } from '../lib/pbx/snapshot.js';
import { workOutLines } from '../lib/pbx/lines.js';
import { scheduleInForce, localDayAndMinute } from '../lib/pbx/schedule.js';
import { displayNumber, canonicalDialled, plusE164 } from '../lib/pbx/numbers.js';
import { validateExtensionParams, effectiveParams } from '../lib/pbx/extension-params.js';
import {
  pbxRelease, releasedExtensionTypes, releasedDestinationKinds, releasedPhoneKinds,
} from '../lib/pbx/release.js';
import { hasCapability, validateCapabilities } from '../lib/capabilities.js';

// November, so London is on UTC. 2026-11-11 is a Wednesday.
const WED_1930 = new Date('2026-11-11T19:30:00Z');
const WED_NOON = new Date('2026-11-11T12:00:00Z');
const THU_0700 = new Date('2026-11-12T07:00:00Z');

const CALLER = '+447700900123';
const REGISTRAR = 'sip.phones.example.net';

const EVENINGS_LONDON = { timezone: 'Europe/London', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '18:00', to: '08:00' }] };

function baseSnapshot() {
  return {
    organisation: { id: 'org-1', capabilities: ['phoneSystem'], mainNumber: '+442079460801' },
    entries: [
      { id: 'e-rob', kind: 'person', name: 'Rob Parkinson' },
      { id: 'e-priya', kind: 'person', name: 'Priya' },
      { id: 'e-ellie', kind: 'person', name: 'Ellie' },
      { id: 'e-sales', kind: 'team', name: 'Sales' },
      { id: 'e-support', kind: 'team', name: 'Support' },
      { id: 'e-accounts', kind: 'service', name: 'Accounts' },
      { id: 'e-office', kind: 'service', name: 'Office PBX' },
    ],
    extensions: [
      { id: 'x-100', number: '100', type: 'ring_all', entryId: 'e-rob', params: {} },
      { id: 'x-101', number: '101', type: 'ring_all', entryId: 'e-priya', params: {} },
      { id: 'x-102', number: '102', type: 'ring_all', entryId: 'e-ellie', params: {} },
      { id: 'x-200', number: '200', type: 'ring_all', entryId: 'e-sales', params: {} },
      { id: 'x-210', number: '210', type: 'ring_all', entryId: 'e-support', params: {} },
      { id: 'x-260', number: '260', type: 'forward', entryId: 'e-accounts', forwardTo: '+442079460999', params: {} },
      { id: 'x-310', number: '310', type: 'connection', entryId: 'e-office', connectionId: 'reg-office-pbx', params: {} },
      { id: 'x-400', number: '400', type: 'agent', entryId: null, instanceId: 'i-pipe', params: {} },
      { id: 'x-401', number: '401', type: 'agent', entryId: null, instanceId: 'i-lk', params: {} },
    ],
    members: [
      { extensionId: 'x-100', entryId: 'e-rob', huntPosition: 1, keyPosition: null },
      { extensionId: 'x-100', entryId: 'e-priya', huntPosition: 2, keyPosition: 1 },
      { extensionId: 'x-101', entryId: 'e-priya', huntPosition: 1, keyPosition: null },
      { extensionId: 'x-102', entryId: 'e-ellie', huntPosition: 1, keyPosition: null },
      { extensionId: 'x-200', entryId: 'e-rob', huntPosition: 1, keyPosition: 1 },
      { extensionId: 'x-200', entryId: 'e-priya', huntPosition: 2, keyPosition: 2 },
      { extensionId: 'x-200', entryId: 'e-ellie', huntPosition: 3, keyPosition: 1 },
      { extensionId: 'x-210', entryId: 'e-ellie', huntPosition: 1, keyPosition: 2 },
    ],
    phones: [
      { id: 'p-rob-desk', kind: 'deskphone', label: 'Rob desk', capacity: 6, labelChars: 10 },
      { id: 'p-rob-home', kind: 'deskphone', label: 'Rob home', capacity: 6, labelChars: 12 },
      { id: 'p-rob-mobile', kind: 'external', label: 'Rob mobile', capacity: 0, number: '+447700900310', ringDelay: 15, shows: 'caller', keyToAnswer: null },
      { id: 'p-priya-desk', kind: 'deskphone', label: 'Priya desk', capacity: 6, labelChars: 12 },
      { id: 'p-ellie-desk', kind: 'deskphone', label: 'Ellie desk', capacity: 6, labelChars: 12 },
    ],
    phonePeople: [
      { phoneId: 'p-rob-desk', entryId: 'e-rob', position: 1 },
      { phoneId: 'p-rob-home', entryId: 'e-rob', position: 1 },
      { phoneId: 'p-rob-mobile', entryId: 'e-rob', position: 1 },
      { phoneId: 'p-priya-desk', entryId: 'e-priya', position: 1 },
      { phoneId: 'p-ellie-desk', entryId: 'e-ellie', position: 1 },
    ],
    rules: [
      { phoneId: 'p-rob-home', appliesTo: 'shared', extensionIds: null, schedule: EVENINGS_LONDON, action: 'do_not_ring', enabled: true },
    ],
    numbers: [
      { number: '+442079460801', extensionId: null, trunkId: 't-1' },
      { number: '+442079460810', extensionId: 'x-200', trunkId: 't-1' },
      { number: '+442079460820', extensionId: 'x-100', trunkId: 't-1' },
      { number: '+442079460860', extensionId: 'x-260', trunkId: 't-1' },
    ],
    connections: [{ id: 'reg-office-pbx' }],
    instances: [
      { id: 'i-pipe', agentId: 'a-1', runtime: 'pipecat' },
      { id: 'i-lk', agentId: 'a-2', runtime: 'livekit' },
    ],
    unregistered: ['p-ellie-desk'],
  };
}

/** Works out each phone's lines, gives them ids, numbers and endpoints, and indexes the result. */
function build(snapshot) {
  const before = indexSnapshot({ ...snapshot, lines: [] });
  const lines = [];
  let lineNumber = 100200;
  for (const phone of snapshot.phones) {
    for (const slot of workOutLines(linesInput(before, phone))) {
      const id = `ln-${phone.id}-${slot.position}`;
      lines.push({
        id,
        phoneId: phone.id,
        position: slot.position,
        kind: slot.kind,
        extensionId: slot.extensionId ?? null,
        covers: slot.covers ?? null,
        lineNumber: ++lineNumber,
        endpoint: phone.kind === 'deskphone'
          ? { id: `ep-${id}`, username: `u-${id}`, registrar: REGISTRAR, registered: !(snapshot.unregistered || []).includes(phone.id), lastSeenAt: null }
          : null,
      });
    }
  }
  return indexSnapshot({ ...snapshot, lines });
}

const toExtension = (extensionId, extra = {}) => ({ kind: 'extension', extensionId, callerId: CALLER, skip: [], hop: 0, ...extra });
const plan = (snapshot, request, now = WED_1930) => buildRingPlan(build(snapshot), request, { now, planId: 'p-1' });
const ext = (snapshot, id) => snapshot.extensions.find((e) => e.id === id);
const allLegs = (result) => result.ring.steps.flatMap((step) => step.legs);
const legFor = (result, phoneId) => allLegs(result).find((leg) => leg.phoneId === phoneId);
const skippedFor = (result, phoneId) => result.skipped.filter((s) => s.phoneId === phoneId);

/** A small desk for Ellie: her own line, then one overflow line for Sales and Support. */
function withSmallEllieDesk() {
  const s = baseSnapshot();
  s.phones.find((p) => p.id === 'p-ellie-desk').capacity = 2;
  return s;
}

describe('ring_all', () => {
  test('Sales 200 at 19:30: the worked example', () => {
    const result = plan(baseSnapshot(), toExtension('x-200'));
    expect(result.action).toBe('ring');
    expect(result.planId).toBe('p-1');
    expect(result.ttlSeconds).toBe(5);
    expect(result.organisationId).toBe('org-1');
    expect(result.target).toEqual({ kind: 'extension', extensionId: 'x-200', number: '200', name: 'Sales', type: 'ring_all', personal: false });
    expect(result.caller).toEqual({ number: CALLER, display: '+44 7700 900123', internal: false });
    expect(result.hours).toEqual({ open: true, timezone: 'Europe/London', nextChangeAt: null });
    expect(result.before).toBeNull();
    expect(result.outOfHours).toBeNull();
    expect(result.noAnswer).toEqual({ kind: 'release' });
    expect(result.recording).toEqual({ record: false });
    expect(result.ring).toMatchObject({ strategy: 'ring_all', ringSeconds: 30, callWaiting: true, order: 'fixed' });
    expect(result.ring.steps).toHaveLength(1);
    const [step] = result.ring.steps;
    expect(step).toMatchObject({ step: 1, seconds: 30, memberEntryIds: ['e-rob', 'e-priya', 'e-ellie'] });

    const display = { name: 'Sales', number: '200', caller: '+44 7700 900123' };
    const strip = ({ legId, phoneLabel, lineId, lineNumber, endpoint, ...rest }) => rest;
    expect(step.legs.map(strip)).toEqual([
      { kind: 'line', entryId: 'e-rob', phoneId: 'p-rob-desk', key: 2, lineKind: 'extension', display, registeredHint: true },
      { kind: 'line', entryId: 'e-priya', phoneId: 'p-priya-desk', key: 3, lineKind: 'extension', display, registeredHint: true },
      { kind: 'line', entryId: 'e-ellie', phoneId: 'p-ellie-desk', key: 2, lineKind: 'extension', display, registeredHint: false },
    ]);
    expect(new Set(step.legs.map((leg) => leg.legId)).size).toBe(3);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { entryId: 'e-rob', phoneId: 'p-rob-home', reason: 'do_not_ring' },
      { entryId: 'e-rob', phoneId: 'p-rob-mobile', reason: 'mobile_not_for_shared' },
    ]));
    expect(result.skipped).toHaveLength(2);
  });

  test('a leg names the phone, the line, the key, the endpoint and the display', () => {
    const result = plan(baseSnapshot(), toExtension('x-200'));
    expect(legFor(result, 'p-rob-desk')).toEqual({
      legId: expect.any(String),
      kind: 'line',
      entryId: 'e-rob',
      phoneId: 'p-rob-desk',
      phoneLabel: 'Rob desk',
      lineId: 'ln-p-rob-desk-2',
      lineNumber: expect.any(Number),
      key: 2,
      lineKind: 'extension',
      endpoint: { username: 'u-ln-p-rob-desk-2', registrar: REGISTRAR },
      display: { name: 'Sales', number: '200', caller: '+44 7700 900123' },
      registeredHint: true,
    });
    const index = build(baseSnapshot());
    expect(legFor(result, 'p-rob-desk').lineNumber).toBe(index.lineById.get('ln-p-rob-desk-2').lineNumber);
  });

  test('ringSeconds sets the step length', () => {
    const s = baseSnapshot();
    ext(s, 'x-200').params = { ringSeconds: 45 };
    const result = plan(s, toExtension('x-200'));
    expect(result.ring.ringSeconds).toBe(45);
    expect(result.ring.steps[0].seconds).toBe(45);
  });

  test('record and noAnswer come from params', () => {
    const s = baseSnapshot();
    ext(s, 'x-200').params = { record: true, noAnswer: { kind: 'extension', extensionId: 'x-210' } };
    const result = plan(s, toExtension('x-200'));
    expect(result.recording).toEqual({ record: true });
    expect(result.noAnswer).toEqual({ kind: 'extension', extensionId: 'x-210', number: '210' });
  });

  test('an overflow line rings for an extension it covers and shows that extension', () => {
    const s = withSmallEllieDesk();
    const index = build(s);
    expect(index.linesByPhone.get('p-ellie-desk').map((l) => [l.position, l.kind])).toEqual([[1, 'extension'], [2, 'other']]);

    const result = buildRingPlan(index, toExtension('x-210'), { now: WED_1930, planId: 'p-1' });
    expect(legFor(result, 'p-ellie-desk')).toMatchObject({
      kind: 'line',
      lineId: 'ln-p-ellie-desk-2',
      key: 2,
      lineKind: 'other',
      display: { name: 'Support', number: '210', caller: '+44 7700 900123' },
    });
  });

  test('Rob 100, personal, with Priya as a member', () => {
    const result = plan(baseSnapshot(), toExtension('x-100'));
    expect(result.target.personal).toBe(true);
    expect(result.ring.steps).toHaveLength(1);
    const legs = allLegs(result).map((leg) => [leg.phoneId, leg.kind, leg.key ?? null]);
    expect(legs).toEqual([
      ['p-rob-desk', 'line', 1],
      ['p-rob-home', 'line', 1],
      ['p-rob-mobile', 'external', null],
      ['p-priya-desk', 'line', 2],
    ]);
    expect(result.skipped).toEqual([]);
  });
});

describe('mobiles', () => {
  test('a mobile rings for its own person\'s extension with the outside fields', () => {
    const result = plan(baseSnapshot(), toExtension('x-100'));
    expect(legFor(result, 'p-rob-mobile')).toEqual({
      legId: expect.any(String),
      kind: 'external',
      entryId: 'e-rob',
      phoneId: 'p-rob-mobile',
      phoneLabel: 'Rob mobile',
      number: '+447700900310',
      delaySeconds: 15,
      presentNumber: CALLER,
      fallbackPresentNumber: '+442079460820',
      keyToAnswer: true,
      outside: true,
    });
  });

  test('shows "extension" presents the extension\'s number', () => {
    const s = baseSnapshot();
    s.phones.find((p) => p.id === 'p-rob-mobile').shows = 'extension';
    const result = plan(s, toExtension('x-100'));
    expect(legFor(result, 'p-rob-mobile').presentNumber).toBe('+442079460820');
  });

  test('shows "extension" uses the outbound number when there is one', () => {
    const s = baseSnapshot();
    s.phones.find((p) => p.id === 'p-rob-mobile').shows = 'extension';
    ext(s, 'x-100').outboundNumber = '+442079460825';
    const leg = legFor(plan(s, toExtension('x-100')), 'p-rob-mobile');
    expect(leg.presentNumber).toBe('+442079460825');
    expect(leg.fallbackPresentNumber).toBe('+442079460825');
  });

  test('keyToAnswer false is kept', () => {
    const s = baseSnapshot();
    s.phones.find((p) => p.id === 'p-rob-mobile').keyToAnswer = false;
    expect(legFor(plan(s, toExtension('x-100')), 'p-rob-mobile').keyToAnswer).toBe(false);
  });

  test('a mobile never rings for a shared extension', () => {
    const result = plan(baseSnapshot(), toExtension('x-200'));
    expect(legFor(result, 'p-rob-mobile')).toBeUndefined();
    expect(skippedFor(result, 'p-rob-mobile')).toEqual([{ entryId: 'e-rob', phoneId: 'p-rob-mobile', reason: 'mobile_not_for_shared' }]);
  });

  test('an assistant\'s mobile does not ring for the owner\'s extension', () => {
    const s = baseSnapshot();
    s.phones.push({ id: 'p-priya-mobile', kind: 'external', label: 'Priya mobile', capacity: 0, number: '+447700900311', ringDelay: 0, shows: 'caller', keyToAnswer: true });
    s.phonePeople.push({ phoneId: 'p-priya-mobile', entryId: 'e-priya', position: 1 });
    const result = plan(s, toExtension('x-100'));
    expect(legFor(result, 'p-priya-mobile')).toBeUndefined();
    expect(skippedFor(result, 'p-priya-mobile')).toEqual([{ entryId: 'e-priya', phoneId: 'p-priya-mobile', reason: 'mobile_not_for_shared' }]);
    // It still rings for her own extension.
    expect(legFor(plan(s, toExtension('x-101')), 'p-priya-mobile')).toMatchObject({ kind: 'external', delaySeconds: 0 });
  });
});

describe('do-not-ring rules', () => {
  const withRule = (rule, phoneId = 'p-rob-desk') => {
    const s = baseSnapshot();
    s.rules = [{ phoneId, extensionIds: null, schedule: { always: true }, action: 'do_not_ring', enabled: true, ...rule }];
    return s;
  };
  const dropped = (s, extensionId, now = WED_1930, phoneId = 'p-rob-desk') => {
    const result = plan(s, toExtension(extensionId), now);
    const leg = legFor(result, phoneId);
    const skip = skippedFor(result, phoneId).find((x) => x.reason === 'do_not_ring');
    expect(Boolean(leg)).toBe(!skip);
    return Boolean(skip);
  };

  test('"all" drops the leg for every extension', () => {
    const s = withRule({ appliesTo: 'all' });
    expect(dropped(s, 'x-100')).toBe(true);
    expect(dropped(s, 'x-200')).toBe(true);
  });

  test('"owned" drops only the person\'s own extension', () => {
    const s = withRule({ appliesTo: 'owned' });
    expect(dropped(s, 'x-100')).toBe(true);
    expect(dropped(s, 'x-200')).toBe(false);
  });

  test('"shared" drops only other extensions', () => {
    const s = withRule({ appliesTo: 'shared' });
    expect(dropped(s, 'x-100')).toBe(false);
    expect(dropped(s, 'x-200')).toBe(true);
  });

  test('"shared" counts the owner\'s extension as shared on an assistant\'s phone', () => {
    const s = withRule({ appliesTo: 'shared' }, 'p-priya-desk');
    expect(dropped(s, 'x-100', WED_1930, 'p-priya-desk')).toBe(true);
    expect(dropped(s, 'x-101', WED_1930, 'p-priya-desk')).toBe(false);
  });

  test('"extensions" drops only the listed extensions', () => {
    const s = withRule({ appliesTo: 'extensions', extensionIds: ['x-200'] });
    expect(dropped(s, 'x-200')).toBe(true);
    expect(dropped(s, 'x-100')).toBe(false);
  });

  test('a schedule out of force does nothing', () => {
    expect(dropped(baseSnapshot(), 'x-200', WED_NOON, 'p-rob-home')).toBe(false);
    expect(dropped(baseSnapshot(), 'x-200', WED_1930, 'p-rob-home')).toBe(true);
  });

  test('a window past midnight is in force early the next morning', () => {
    expect(dropped(baseSnapshot(), 'x-200', THU_0700, 'p-rob-home')).toBe(true);
  });

  test('the schedule is read in the rule\'s own time zone', () => {
    const office = (timezone) => ({ timezone, windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }] });
    // 19:30 in London is 14:30 in New York.
    expect(dropped(withRule({ appliesTo: 'all', schedule: office('America/New_York') }), 'x-200')).toBe(true);
    expect(dropped(withRule({ appliesTo: 'all', schedule: office('Europe/London') }), 'x-200')).toBe(false);
  });

  test('an overflow line is matched by the target extension, not the line', () => {
    const shared = withSmallEllieDesk();
    shared.rules = [{ phoneId: 'p-ellie-desk', appliesTo: 'shared', extensionIds: null, schedule: { always: true }, action: 'do_not_ring', enabled: true }];
    expect(dropped(shared, 'x-210', WED_1930, 'p-ellie-desk')).toBe(true);

    const listed = withSmallEllieDesk();
    listed.rules = [{ phoneId: 'p-ellie-desk', appliesTo: 'extensions', extensionIds: ['x-200'], schedule: { always: true }, action: 'do_not_ring', enabled: true }];
    expect(dropped(listed, 'x-200', WED_1930, 'p-ellie-desk')).toBe(true);
    expect(dropped(listed, 'x-210', WED_1930, 'p-ellie-desk')).toBe(false);
  });

  test('a disabled rule does nothing', () => {
    expect(dropped(withRule({ appliesTo: 'all', enabled: false }), 'x-200')).toBe(false);
  });
});

describe('legs and skipped phones', () => {
  test('a phone shared by two members of the target rings once', () => {
    const s = baseSnapshot();
    s.phones.push({ id: 'p-front', kind: 'deskphone', label: 'Front desk', capacity: 6, labelChars: 12 });
    s.phonePeople.push({ phoneId: 'p-front', entryId: 'e-rob', position: 1 }, { phoneId: 'p-front', entryId: 'e-priya', position: 2 });
    const result = plan(s, toExtension('x-200'));
    expect(allLegs(result).filter((leg) => leg.phoneId === 'p-front')).toHaveLength(1);
    expect(skippedFor(result, 'p-front')).toEqual([]);
  });

  test('a phone with no line for the extension is skipped with no_line', () => {
    const index = build(baseSnapshot());
    const lines = index.linesByPhone.get('p-ellie-desk').filter((line) => line.extensionId !== 'x-200');
    const snapshot = { ...baseSnapshot(), lines: [...index.lineById.values()].filter((l) => l.phoneId !== 'p-ellie-desk').concat(lines) };
    const result = buildRingPlan(indexSnapshot(snapshot), toExtension('x-200'), { now: WED_NOON });
    expect(legFor(result, 'p-ellie-desk')).toBeUndefined();
    expect(result.skipped).toContainEqual({ entryId: 'e-ellie', phoneId: 'p-ellie-desk', reason: 'no_line' });
  });

  test('every skipped entry has a known reason', () => {
    const s = baseSnapshot();
    s.rules.push({ phoneId: 'p-priya-desk', appliesTo: 'all', schedule: { always: true }, action: 'do_not_ring', enabled: true });
    const result = plan(s, toExtension('x-200'));
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const entry of result.skipped) expect(['do_not_ring', 'mobile_not_for_shared', 'no_line']).toContain(entry.reason);
  });
});

describe('hunt', () => {
  test('one step for each member in hunt order, 20 seconds by default', () => {
    const s = baseSnapshot();
    ext(s, 'x-200').type = 'hunt';
    // Hunt order differs from the order the members were added.
    for (const m of s.members.filter((x) => x.extensionId === 'x-200')) {
      m.huntPosition = { 'e-ellie': 1, 'e-rob': 2, 'e-priya': 3 }[m.entryId];
    }
    const result = plan(s, toExtension('x-200'), WED_NOON);
    expect(result.action).toBe('ring');
    expect(result.ring.strategy).toBe('hunt');
    expect(result.ring.order).toBe('fixed');
    expect(result.ring.steps.map((step) => [step.step, step.seconds, step.memberEntryIds])).toEqual([
      [1, 20, ['e-ellie']],
      [2, 20, ['e-rob']],
      [3, 20, ['e-priya']],
    ]);
    expect(result.ring.steps[1].legs.map((leg) => leg.phoneId)).toEqual(['p-rob-desk', 'p-rob-home']);
    expect(result.ring.steps[0].legs.map((leg) => leg.phoneId)).toEqual(['p-ellie-desk']);
    expect(result.ring.steps[2].legs.map((leg) => leg.phoneId)).toEqual(['p-priya-desk']);
  });

  test('stepSeconds and order come from params', () => {
    const s = baseSnapshot();
    ext(s, 'x-200').type = 'hunt';
    ext(s, 'x-200').params = { stepSeconds: 25, order: 'round_robin' };
    const result = plan(s, toExtension('x-200'), WED_NOON);
    expect(result.ring.steps.every((step) => step.seconds === 25)).toBe(true);
    expect(result.ring.order).toBe('round_robin');
  });
});

describe('the other actions', () => {
  test('forward', () => {
    const result = plan(baseSnapshot(), toExtension('x-260'));
    expect(result.action).toBe('forward');
    expect(result.forward).toEqual({ number: '+442079460999', presentNumber: CALLER, fallbackPresentNumber: '+442079460860', outside: true });
  });

  test('connection with a connection id', () => {
    const result = plan(baseSnapshot(), toExtension('x-310'));
    expect(result.action).toBe('connection');
    expect(result.connection).toEqual({ connectionId: 'reg-office-pbx', digits: '310', via: 'registration' });
  });

  test('connection without an id uses the only registration connection', () => {
    const s = baseSnapshot();
    ext(s, 'x-310').connectionId = null;
    s.connections = [{ id: 'reg-only' }];
    expect(plan(s, toExtension('x-310')).connection).toEqual({ connectionId: 'reg-only', digits: '310', via: 'registration' });
  });

  test.each([[0], [2]])('connection without an id and %i registration connections is refused', (count) => {
    const s = baseSnapshot();
    ext(s, 'x-310').connectionId = null;
    s.connections = Array.from({ length: count }, (_, i) => ({ id: `reg-${i}` }));
    const result = plan(s, toExtension('x-310'));
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('connection_not_set');
  });

  test('agent with a pipecat instance', () => {
    const result = plan(baseSnapshot(), toExtension('x-400'));
    expect(result.action).toBe('agent');
    expect(result.agent).toEqual({ instanceId: 'i-pipe', agentId: 'a-1', runtime: 'pipecat' });
  });

  test('agent on another runtime is refused', () => {
    const result = plan(baseSnapshot(), toExtension('x-401'));
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('runtime_not_supported');
  });
});

describe('where the call goes', () => {
  const routed = (params) => {
    const s = baseSnapshot();
    ext(s, 'x-200').params = params;
    return s;
  };
  const hours = { timezone: 'Europe/London', windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:30' }] };
  const outOfHours = { kind: 'external', number: '+442079460999' };
  const before = { kind: 'agent', instanceId: 'i-pipe' };

  test('out of hours comes first', () => {
    const result = plan(routed({ openingHours: hours, outOfHours, before }), toExtension('x-200'), WED_1930);
    expect(result.hours).toEqual({ open: false, timezone: 'Europe/London', nextChangeAt: null });
    expect(result.outOfHours).toMatchObject({ kind: 'external', number: '+442079460999' });
    expect(result.action).toBe('forward');
    expect(result.forward).toMatchObject({ number: '+442079460999', outside: true });
  });

  test('in hours, before comes next', () => {
    const result = plan(routed({ openingHours: hours, outOfHours, before }), toExtension('x-200'), WED_NOON);
    expect(result.hours.open).toBe(true);
    expect(result.before).toEqual({ kind: 'agent', instanceId: 'i-pipe', agentId: 'a-1', runtime: 'pipecat' });
    expect(result.action).toBe('agent');
  });

  test('closed with no out-of-hours destination falls to before', () => {
    const result = plan(routed({ openingHours: hours, before }), toExtension('x-200'), WED_1930);
    expect(result.hours.open).toBe(false);
    expect(result.action).toBe('agent');
  });

  test('skip "before" passes over it to the type', () => {
    const result = plan(routed({ before }), toExtension('x-200', { skip: ['before'], hop: 1 }), WED_NOON);
    expect(result.action).toBe('ring');
  });

  test('a before destination that names an extension gives that extension\'s plan', () => {
    const result = plan(routed({ before: { kind: 'extension', extensionId: 'x-100' } }), toExtension('x-200'), WED_NOON);
    expect(result.action).toBe('ring');
    expect(result.target.extensionId).toBe('x-100');
    expect(result.redirectedFrom).toMatchObject({ extensionId: 'x-200', number: '200' });
  });

  test('more than five hops is refused', () => {
    expect(MAX_HOPS).toBe(5);
    expect(plan(baseSnapshot(), toExtension('x-200', { hop: 5 })).action).toBe('ring');
    const result = plan(baseSnapshot(), toExtension('x-200', { hop: 6 }));
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('too_many_hops');
  });
});

describe('dialled digits', () => {
  const ROB_LINE = 'ln-p-rob-desk-1';
  const dial = (snapshot, digits, lineId = ROB_LINE) => plan(snapshot, { kind: 'dialled', lineId, digits });

  test.each(['999', '112'])('%s is an emergency call', (digits) => {
    const result = dial(baseSnapshot(), digits);
    expect(result.action).toBe('emergency');
    expect(result.emergency).toMatchObject({ presentNumber: '+442079460820' });
    expect(result.emergency).toHaveProperty('addressState');
  });

  test('an emergency call is placed even without the capability', () => {
    const s = baseSnapshot();
    s.organisation.capabilities = [];
    expect(dial(s, '999').action).toBe('emergency');
  });

  test('an extension number gives that extension\'s plan as an internal call', () => {
    const result = dial(baseSnapshot(), '200');
    expect(result.action).toBe('ring');
    expect(result.target).toMatchObject({ extensionId: 'x-200', number: '200' });
    expect(result.caller.internal).toBe(true);
    // Rob's own line on a 10-character key.
    expect(result.caller.display).toBe('Rob P. 100');
    expect(result.from).toEqual({
      lineId: ROB_LINE,
      lineNumber: build(baseSnapshot()).lineById.get(ROB_LINE).lineNumber,
      phoneId: 'p-rob-desk',
      extensionId: 'x-100',
      extensionNumber: '100',
    });
  });

  test.each(['02079460999', '+442079460999', '00442079460999'])('%s goes out as +442079460999', (digits) => {
    const result = dial(baseSnapshot(), digits);
    expect(result.action).toBe('outside');
    expect(result.outside).toEqual({ number: '+442079460999', presentNumber: '+442079460820' });
  });

  test.each(['12ab', '*#', ''])('junk "%s" is refused', (digits) => {
    const result = dial(baseSnapshot(), digits);
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('invalid_number');
  });
});

describe('caller ID for a call out from a line', () => {
  const ROB_LINE = 'ln-p-rob-desk-1';
  const presented = (snapshot, lineId = ROB_LINE) => plan(snapshot, { kind: 'dialled', lineId, digits: '02079460999' });

  test('the extension\'s outbound number first', () => {
    const s = baseSnapshot();
    ext(s, 'x-100').outboundNumber = '+442079460825';
    expect(presented(s).outside.presentNumber).toBe('+442079460825');
  });

  test('then its only routed number', () => {
    expect(presented(baseSnapshot()).outside.presentNumber).toBe('+442079460820');
  });

  test('then the organisation\'s main number', () => {
    const s = baseSnapshot();
    s.numbers = s.numbers.filter((n) => n.extensionId !== 'x-100');
    expect(presented(s).outside.presentNumber).toBe('+442079460801');
  });

  test('two routed numbers and no outbound number use the main number', () => {
    const s = baseSnapshot();
    s.numbers.push({ number: '+442079460826', extensionId: 'x-100', trunkId: 't-1' });
    expect(presented(s).outside.presentNumber).toBe('+442079460801');
  });

  test('the overflow line uses the own extension of the phone\'s first user', () => {
    const s = withSmallEllieDesk();
    ext(s, 'x-102').outboundNumber = '+442079460830';
    s.phonePeople.push({ phoneId: 'p-ellie-desk', entryId: 'e-priya', position: 2 });
    s.phones.find((p) => p.id === 'p-ellie-desk').capacity = 3;
    const index = build(s);
    const other = index.linesByPhone.get('p-ellie-desk').find((line) => line.kind === 'other');
    expect(other).toBeDefined();
    const result = buildRingPlan(index, { kind: 'dialled', lineId: other.id, digits: '02079460999' }, { now: WED_1930 });
    expect(result.outside.presentNumber).toBe('+442079460830');
  });

  test('no number at all is refused', () => {
    const s = baseSnapshot();
    s.organisation.mainNumber = null;
    s.numbers = [];
    const result = presented(s);
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('no_caller_id');
  });

  test('shownNumber gives the same order', () => {
    const s = baseSnapshot();
    const index = build(s);
    expect(shownNumber(index, index.extensions.get('x-100')).number).toBe('+442079460820');
    expect(shownNumber(index, index.extensions.get('x-102')).number).toBe('+442079460801');
  });
});

describe('the capability', () => {
  test('without it the plan is refused', () => {
    const s = baseSnapshot();
    s.organisation.capabilities = [];
    const result = plan(s, toExtension('x-200'));
    expect(result.action).toBe('refuse');
    expect(result.reason).toBe('phone_system_disabled');
  });

  test('hasCapability and validateCapabilities', () => {
    expect(hasCapability({ capabilities: ['phoneSystem'] }, 'phoneSystem')).toBe(true);
    expect(hasCapability({ capabilities: [] }, 'phoneSystem')).toBe(false);
    expect(hasCapability(null, 'phoneSystem')).toBe(false);
    expect(validateCapabilities(['phoneSystem'])).toBeNull();
    expect(validateCapabilities([])).toBeNull();
    expect(typeof validateCapabilities(['teleport'])).toBe('string');
    expect(typeof validateCapabilities('phoneSystem')).toBe('string');
  });
});

describe('schedules', () => {
  const evenings = { timezone: 'Europe/London', windows: [{ days: [5], from: '22:00', to: '02:00' }] };

  test('no schedule and "always" are in force', () => {
    expect(scheduleInForce(null, WED_NOON)).toBe(true);
    expect(scheduleInForce({ always: true }, WED_NOON)).toBe(true);
  });

  test('a plain window', () => {
    const office = { timezone: 'Europe/London', windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:30' }] };
    expect(scheduleInForce(office, WED_NOON)).toBe(true);
    expect(scheduleInForce(office, WED_1930)).toBe(false);
    // Saturday noon.
    expect(scheduleInForce(office, new Date('2026-11-14T12:00:00Z'))).toBe(false);
  });

  test('a window past midnight belongs to the day it starts', () => {
    expect(scheduleInForce(evenings, new Date('2026-11-13T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(scheduleInForce(evenings, new Date('2026-11-14T01:00:00Z'))).toBe(true); // Saturday 01:00
    expect(scheduleInForce(evenings, new Date('2026-11-13T01:00:00Z'))).toBe(false); // Friday 01:00
    expect(scheduleInForce(evenings, new Date('2026-11-14T03:00:00Z'))).toBe(false); // Saturday 03:00
  });

  test('localDayAndMinute reads the time zone', () => {
    expect(localDayAndMinute(WED_1930, 'Europe/London')).toEqual({ day: 3, minute: 19 * 60 + 30 });
    expect(localDayAndMinute(WED_1930, 'America/New_York')).toEqual({ day: 3, minute: 14 * 60 + 30 });
    expect(localDayAndMinute(new Date('2026-11-11T23:30:00Z'), 'Asia/Tokyo')).toEqual({ day: 4, minute: 8 * 60 + 30 });
  });
});

describe('numbers', () => {
  test('displayNumber groups UK numbers', () => {
    expect(displayNumber('+442079460810')).toBe('+44 20 7946 0810');
    expect(displayNumber('+447700900123')).toBe('+44 7700 900123');
    expect(displayNumber('442079460810')).toBe('+44 20 7946 0810');
  });

  test('displayNumber leaves other numbers in E.164 form', () => {
    expect(displayNumber('+12125550123')).toBe('+12125550123');
    expect(displayNumber('+33142685300')).toBe('+33142685300');
  });

  test('canonicalDialled', () => {
    expect(canonicalDialled('02079460999')).toBe('+442079460999');
    expect(canonicalDialled('+442079460999')).toBe('+442079460999');
    expect(canonicalDialled('00442079460999')).toBe('+442079460999');
    expect(canonicalDialled('07700900123')).toBe('+447700900123');
    expect(canonicalDialled('0142685300', { countryCode: '33' })).toBe('+33142685300');
    expect(canonicalDialled('020 7946 0999x')).toBeNull();
    expect(canonicalDialled('abc')).toBeNull();
    expect(canonicalDialled('')).toBeNull();
  });

  test('plusE164', () => {
    expect(plusE164('442079460810')).toBe('+442079460810');
    expect(plusE164('+442079460810')).toBe('+442079460810');
    expect(plusE164('')).toBeNull();
  });
});

describe('extension params', () => {
  const ok = (type, params, release) => validateExtensionParams(type, params, { release });
  const refusedAs = (result, code, field) => {
    expect(result.ok).toBe(false);
    expect(result.code).toBe(code);
    expect(result.field).toBe(field);
  };

  test('ringSeconds is a whole number from 5 to 300', () => {
    expect(ok('ring_all', { ringSeconds: 5 }, '1').ok).toBe(true);
    expect(ok('ring_all', { ringSeconds: 300 }, '1').ok).toBe(true);
    for (const value of [4, 301, 30.5, '30']) refusedAs(ok('ring_all', { ringSeconds: value }, '1'), 'invalid_params', 'params.ringSeconds');
  });

  test('callWaiting and record are booleans', () => {
    expect(ok('ring_all', { callWaiting: false, record: true }, '1')).toEqual({ ok: true, params: { callWaiting: false, record: true } });
    refusedAs(ok('ring_all', { record: 'yes' }, '1'), 'invalid_params', 'params.record');
  });

  test('an unknown key is refused', () => {
    refusedAs(ok('ring_all', { colour: 'blue' }, '4'), 'invalid_params', 'params.colour');
  });

  test('stepSeconds and order are only for hunt, from release 1c', () => {
    expect(ok('hunt', { stepSeconds: 5, order: 'longest_idle' }, '1c').ok).toBe(true);
    expect(ok('hunt', { stepSeconds: 120, order: 'round_robin' }, '1c').ok).toBe(true);
    expect(ok('hunt', { order: 'fixed' }, '1c').ok).toBe(true);
    refusedAs(ok('hunt', { stepSeconds: 4 }, '1c'), 'invalid_params', 'params.stepSeconds');
    refusedAs(ok('hunt', { stepSeconds: 121 }, '1c'), 'invalid_params', 'params.stepSeconds');
    refusedAs(ok('hunt', { order: 'random' }, '1c'), 'invalid_params', 'params.order');
    refusedAs(ok('ring_all', { stepSeconds: 20 }, '1c'), 'invalid_params', 'params.stepSeconds');
    refusedAs(ok('ring_all', { order: 'fixed' }, '1c'), 'invalid_params', 'params.order');
    expect(ok('hunt', { stepSeconds: 20 }, '1').ok).toBe(false);
    expect(ok('hunt', { order: 'fixed' }, '1').ok).toBe(false);
  });

  test('a destination before release 1c is not available', () => {
    const external = { kind: 'external', number: '+442079460999' };
    const extension = { kind: 'extension', extensionId: '3f0c2d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f' };
    for (const key of ['before', 'noAnswer', 'outOfHours']) {
      refusedAs(ok('ring_all', { [key]: external }, '1'), 'destination_not_available', `params.${key}`);
      expect(ok('ring_all', { [key]: external }, '1c').ok).toBe(true);
      expect(ok('ring_all', { [key]: extension }, '1c').ok).toBe(true);
    }
  });

  test('an agent destination before release 2 is not available', () => {
    const agent = { kind: 'agent', instanceId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d' };
    refusedAs(ok('ring_all', { before: agent }, '1c'), 'destination_not_available', 'params.before');
    refusedAs(ok('ring_all', { before: agent }, '1'), 'destination_not_available', 'params.before');
    expect(ok('ring_all', { before: agent }, '2').ok).toBe(true);
  });

  test('effectiveParams fills in the defaults', () => {
    expect(effectiveParams({})).toEqual({
      ringSeconds: 30,
      callWaiting: true,
      record: false,
      stepSeconds: 20,
      order: 'fixed',
      openingHours: null,
      before: null,
      noAnswer: null,
      outOfHours: null,
    });
    expect(effectiveParams({ ringSeconds: 60, callWaiting: false })).toMatchObject({ ringSeconds: 60, callWaiting: false, record: false });
  });
});

describe('releases', () => {
  const sorted = (list) => [...list].sort();

  test('PBX_RELEASE is read from the environment', () => {
    for (const release of ['1', '1c', '2', '3', '4']) expect(pbxRelease({ PBX_RELEASE: release })).toBe(release);
  });

  test.each([
    ['1', ['connection', 'ring_all'], [], ['deskphone', 'external']],
    ['1c', ['connection', 'ring_all', 'hunt', 'forward'], ['extension', 'external'], ['deskphone', 'external']],
    ['2', ['connection', 'ring_all', 'hunt', 'forward', 'agent'], ['extension', 'external', 'agent'], ['deskphone', 'external', 'browser']],
    ['3', ['connection', 'ring_all', 'hunt', 'forward', 'agent'], ['extension', 'external', 'agent'], ['deskphone', 'external', 'browser']],
    ['4', ['connection', 'ring_all', 'hunt', 'forward', 'agent', 'queue'], ['extension', 'external', 'agent'], ['deskphone', 'external', 'browser']],
  ])('release %s', (release, types, destinations, phoneKinds) => {
    expect(sorted(releasedExtensionTypes(release))).toEqual(sorted(types));
    expect(sorted(releasedDestinationKinds(release))).toEqual(sorted(destinations));
    expect(sorted(releasedPhoneKinds(release))).toEqual(sorted(phoneKinds));
  });
});
