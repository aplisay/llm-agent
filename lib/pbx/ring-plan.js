/**
 * The ring plan: what a call to an extension, or digits dialled on a line,
 * should do. Pure. It reads an indexed snapshot (lib/pbx/snapshot.js) and
 * decides nothing from live state: whether a phone is busy or connected is
 * known only to call control, which filters the legs it is given.
 */
import { randomUUID } from 'node:crypto';
import { hasCapability } from '../capabilities.js';
import { effectiveParams, DEFAULT_RING_SECONDS } from './extension-params.js';
import { scheduleInForce } from './schedule.js';
import { displayNumber, canonicalDialled, plusE164, EMERGENCY_NUMBERS } from './numbers.js';
import { isPersonal, shownNumber, lineForExtension, callingExtension, labelFor } from './snapshot.js';

export const MAX_HOPS = 5;
export const PLAN_TTL_SECONDS = 5;
const DEFAULT_TIMEZONE = 'Europe/London';

const base = (ctx) => ({ planId: ctx.planId, ttlSeconds: PLAN_TTL_SECONDS, organisationId: ctx.index.organisation.id });
const refuse = (ctx, reason, extra = {}) => ({ ...base(ctx), action: 'refuse', reason, ...extra });

/**
 * @param {object} index    indexSnapshot(snapshot)
 * @param {object} request  one of
 *   `{ kind: 'extension', extensionId, callerId, skip, hop }`
 *   `{ kind: 'dialled', lineId, digits }`
 *   `{ kind: 'line', lineNumber, callerId }`
 * @param {object} [opts]   `{ now, planId, otherWord, countryCode }`
 */
export function buildRingPlan(index, request, opts = {}) {
  const ctx = {
    index,
    now: opts.now ?? new Date(),
    planId: opts.planId ?? `p-${randomUUID()}`,
    otherWord: opts.otherWord ?? 'Other',
    countryCode: opts.countryCode ?? '44',
  };
  // An emergency call is answered before the capability is looked at: it must
  // never be refused because a switch is off.
  if (request?.kind === 'dialled' && EMERGENCY_NUMBERS.includes(String(request.digits ?? '').trim())) {
    return planForEmergency(ctx, request);
  }
  if (!hasCapability(index.organisation, 'phoneSystem')) return refuse(ctx, 'phone_system_disabled');
  switch (request?.kind) {
    case 'extension': return planForExtension(ctx, request);
    case 'dialled': return planForDialled(ctx, request);
    case 'line': return planForLine(ctx, request);
    default: return refuse(ctx, 'bad_request');
  }
}

function outsideCaller(callerId) {
  const number = /[0-9]/.test(String(callerId ?? '')) ? plusE164(callerId) : null;
  return { number, display: number ? displayNumber(number) : '', internal: false };
}

/** A destination as the plan states it, or null. */
function destinationOut(ctx, extension, destination, caller) {
  if (!destination) return null;
  if (destination.kind === 'agent') {
    const instance = ctx.index.instances.get(destination.instanceId);
    return { kind: 'agent', instanceId: destination.instanceId, agentId: instance?.agentId ?? null, runtime: instance?.runtime ?? null };
  }
  if (destination.kind === 'extension') {
    return { kind: 'extension', extensionId: destination.extensionId, number: ctx.index.extensions.get(destination.extensionId)?.number ?? null };
  }
  return { kind: 'external', number: destination.number, presentNumber: presentOutside(ctx, extension, caller) };
}

/** The number an outside leg shows: the caller's own when it came from outside, else the extension's. */
function presentOutside(ctx, extension, caller) {
  const shown = shownNumber(ctx.index, extension).number;
  return caller?.internal ? shown : (caller?.number ?? shown);
}

function agentAction(ctx, instanceId) {
  const instance = ctx.index.instances.get(instanceId);
  if (!instance) return { action: 'refuse', reason: 'agent_not_available' };
  if (instance.runtime !== 'pipecat') return { action: 'refuse', reason: 'runtime_not_supported' };
  return { action: 'agent', agent: { instanceId: instance.id, agentId: instance.agentId, runtime: instance.runtime } };
}

function planForExtension(ctx, request) {
  const { index } = ctx;
  const hop = Number(request.hop) || 0;
  if (hop > MAX_HOPS) return refuse(ctx, 'too_many_hops');
  const extension = index.extensions.get(request.extensionId);
  if (!extension) return refuse(ctx, 'extension_not_found');

  const skip = Array.isArray(request.skip) ? request.skip : [];
  const params = effectiveParams(extension.params);
  const caller = request.caller ?? outsideCaller(request.callerId);
  const target = {
    kind: 'extension',
    extensionId: extension.id,
    number: extension.number,
    name: index.entries.get(extension.entryId)?.name ?? extension.number,
    type: extension.type,
    personal: isPersonal(index, extension),
  };
  const hours = {
    open: params.openingHours ? scheduleInForce(params.openingHours, ctx.now) : true,
    timezone: params.openingHours?.timezone ?? DEFAULT_TIMEZONE,
    nextChangeAt: null,
  };
  const plan = {
    ...base(ctx),
    action: null,
    target,
    caller,
    hours,
    before: destinationOut(ctx, extension, params.before, caller),
    outOfHours: destinationOut(ctx, extension, params.outOfHours, caller),
    noAnswer: destinationOut(ctx, extension, params.noAnswer, caller) ?? { kind: 'release' },
    recording: { record: params.record },
    skipped: [],
    ...(request.from ? { from: request.from } : {}),
  };

  // Where the call goes: out of hours first, then "before it rings", then the type.
  let elsewhere = null;
  let why = null;
  if (!hours.open && params.outOfHours) [elsewhere, why] = [params.outOfHours, 'out_of_hours'];
  else if (params.before && !skip.includes('before')) [elsewhere, why] = [params.before, 'before'];
  if (elsewhere) {
    if (elsewhere.kind === 'extension') {
      const onward = planForExtension(ctx, { ...request, extensionId: elsewhere.extensionId, skip: [], hop: hop + 1 });
      return { ...onward, redirectedFrom: { extensionId: extension.id, number: extension.number, reason: why } };
    }
    if (elsewhere.kind === 'agent') return { ...plan, ...agentAction(ctx, elsewhere.instanceId) };
    return { ...plan, action: 'forward', forward: forwardBlock(ctx, extension, elsewhere.number, caller) };
  }

  switch (extension.type) {
    case 'ring_all':
    case 'hunt': {
      const ring = ringBlock(ctx, extension, params, target, caller, plan.skipped);
      return { ...plan, action: 'ring', ring };
    }
    case 'forward':
      return { ...plan, action: 'forward', forward: forwardBlock(ctx, extension, extension.forwardTo, caller) };
    case 'connection': {
      // No connection named means the organisation's only one, as before the phone system.
      const connectionId = extension.connectionId ?? (index.connections.length === 1 ? index.connections[0].id : null);
      if (!connectionId) return { ...plan, action: 'refuse', reason: 'connection_not_set' };
      return { ...plan, action: 'connection', connection: { connectionId, digits: extension.number, via: 'registration' } };
    }
    case 'agent':
      return { ...plan, ...agentAction(ctx, extension.instanceId) };
    default:
      return { ...plan, action: 'refuse', reason: 'type_not_supported' };
  }
}

function forwardBlock(ctx, extension, number, caller) {
  return {
    number,
    presentNumber: presentOutside(ctx, extension, caller),
    fallbackPresentNumber: shownNumber(ctx.index, extension).number,
    outside: true,
  };
}

/** True when a do-not-ring rule of the phone stops a call to this extension now. */
function ruleStops(ctx, phone, extension) {
  const { index } = ctx;
  const rules = index.rulesByPhone.get(phone.id) || [];
  if (!rules.length) return false;
  // A line counts as owned when the extension belongs to one of the phone's people.
  const ownedHere = isPersonal(index, extension)
    && (index.peopleByPhone.get(phone.id) || []).some((person) => person.entryId === extension.entryId);
  return rules.some((rule) => {
    if (rule.enabled === false || rule.action !== 'do_not_ring') return false;
    const applies = rule.appliesTo === 'all'
      || (rule.appliesTo === 'owned' && ownedHere)
      || (rule.appliesTo === 'shared' && !ownedHere)
      || (rule.appliesTo === 'extensions' && (rule.extensionIds || []).includes(extension.id));
    return applies && scheduleInForce(rule.schedule, ctx.now);
  });
}

function ringBlock(ctx, extension, params, target, caller, skipped) {
  const { index } = ctx;
  const members = index.membersByExtension.get(extension.id) || [];
  let legCount = 0;

  const legsFor = (entryIds) => {
    const legs = [];
    const seen = new Set();
    for (const entryId of entryIds) {
      for (const phone of index.phonesByEntry.get(entryId) || []) {
        if (phone.kind === 'external') {
          // An outside number rings only for its own user's own extension.
          if (extension.entryId !== entryId || !target.personal) {
            skipped.push({ entryId, phoneId: phone.id, reason: 'mobile_not_for_shared' });
            continue;
          }
          if (seen.has(phone.id)) continue;
          seen.add(phone.id);
          if (ruleStops(ctx, phone, extension)) {
            skipped.push({ entryId, phoneId: phone.id, reason: 'do_not_ring' });
            continue;
          }
          const shown = shownNumber(index, extension).number;
          legs.push({
            legId: `l-${++legCount}`,
            kind: 'external',
            entryId,
            phoneId: phone.id,
            phoneLabel: phone.label,
            number: phone.number,
            delaySeconds: phone.ringDelay ?? 0,
            presentNumber: phone.shows === 'extension' ? shown : presentOutside(ctx, extension, caller),
            fallbackPresentNumber: shown,
            keyToAnswer: phone.keyToAnswer ?? true,
            outside: true,
          });
          continue;
        }
        const line = lineForExtension(index, phone.id, extension.id);
        if (!line) {
          skipped.push({ entryId, phoneId: phone.id, reason: 'no_line' });
          continue;
        }
        // One leg for each phone and line: a phone shared by two members rings once.
        const key = `${phone.id}:${line.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (ruleStops(ctx, phone, extension)) {
          skipped.push({ entryId, phoneId: phone.id, reason: 'do_not_ring' });
          continue;
        }
        legs.push({
          legId: `l-${++legCount}`,
          kind: phone.kind === 'browser' ? 'browser' : 'line',
          entryId,
          phoneId: phone.id,
          phoneLabel: phone.label,
          lineId: line.id,
          lineNumber: line.lineNumber,
          key: line.position,
          lineKind: line.kind,
          ...(line.endpoint ? { endpoint: { username: line.endpoint.username, registrar: line.endpoint.registrar } } : {}),
          // On the overflow line the display still names the extension the call is for.
          display: { name: target.name, number: extension.number, caller: caller.display },
          registeredHint: Boolean(line.endpoint?.registered),
        });
      }
    }
    return legs;
  };

  const entryIds = members.map((member) => member.entryId);
  const common = { ringSeconds: params.ringSeconds, callWaiting: params.callWaiting, order: params.order };
  if (extension.type === 'hunt') {
    // One step for each member, in hunt order. All of that member's phones ring together.
    return {
      strategy: 'hunt',
      ...common,
      steps: entryIds.map((entryId, i) => ({ step: i + 1, seconds: params.stepSeconds, memberEntryIds: [entryId], legs: legsFor([entryId]) })),
    };
  }
  return {
    strategy: 'ring_all',
    ...common,
    order: 'fixed',
    steps: [{ step: 1, seconds: params.ringSeconds, memberEntryIds: entryIds, legs: legsFor(entryIds) }],
  };
}

/** Where a call from a line comes from, for the plan and for the call record. */
function fromLine(ctx, line) {
  const { index } = ctx;
  const phone = index.phones.get(line.phoneId);
  const extension = callingExtension(index, line);
  return {
    phone,
    extension,
    shown: shownNumber(index, extension).number,
    from: {
      lineId: line.id,
      lineNumber: line.lineNumber,
      phoneId: line.phoneId,
      extensionId: extension?.id ?? null,
      extensionNumber: extension?.number ?? null,
    },
    caller: { number: extension?.number ?? null, display: phone ? labelFor(index, phone, line, ctx.otherWord) : '', internal: true },
  };
}

function planForEmergency(ctx, request) {
  const line = ctx.index.lineById.get(request.lineId);
  if (!line) return { ...base(ctx), action: 'emergency', emergency: { number: String(request.digits).trim(), presentNumber: null, addressState: 'not_entered' } };
  const { shown, from, caller } = fromLine(ctx, line);
  const record = ctx.index.numbers.find((number) => number.number === shown);
  return {
    ...base(ctx),
    action: 'emergency',
    emergency: { number: String(request.digits).trim(), presentNumber: shown, addressState: record?.emergencyRecordState ?? 'not_entered' },
    caller,
    from,
  };
}

function planForDialled(ctx, request) {
  const { index } = ctx;
  const line = index.lineById.get(request.lineId);
  if (!line) return refuse(ctx, 'line_not_found');
  const digits = String(request.digits ?? '').trim();
  const { shown, from, caller } = fromLine(ctx, line);

  const extension = index.extensionByNumber.get(digits);
  if (extension) return planForExtension(ctx, { extensionId: extension.id, caller, from, hop: 0 });

  const number = canonicalDialled(digits, { countryCode: ctx.countryCode });
  if (!number) return refuse(ctx, 'invalid_number', { caller, from });
  if (!shown) return refuse(ctx, 'no_caller_id', { caller, from });
  // Call control must still ask the outbound authorisation before it places the leg.
  return { ...base(ctx), action: 'outside', outside: { number, presentNumber: shown }, caller, from };
}

/** A transfer to one line by its line number. Rules are not applied: the line was named. */
function planForLine(ctx, request) {
  const { index } = ctx;
  const line = index.lineByNumber.get(Number(request.lineNumber));
  const phone = line && index.phones.get(line.phoneId);
  if (!line || !phone) return refuse(ctx, 'line_not_found');
  const caller = request.caller ?? outsideCaller(request.callerId);
  const label = labelFor(index, phone, line, ctx.otherWord);
  const extension = line.kind === 'extension' ? index.extensions.get(line.extensionId) : null;
  const first = (index.peopleByPhone.get(phone.id) || [])[0];
  const leg = {
    legId: 'l-1',
    kind: phone.kind === 'browser' ? 'browser' : 'line',
    entryId: first?.entryId ?? null,
    phoneId: phone.id,
    phoneLabel: phone.label,
    lineId: line.id,
    lineNumber: line.lineNumber,
    key: line.position,
    lineKind: line.kind,
    ...(line.endpoint ? { endpoint: { username: line.endpoint.username, registrar: line.endpoint.registrar } } : {}),
    display: { name: label, number: extension?.number ?? '', caller: caller.display },
    registeredHint: Boolean(line.endpoint?.registered),
  };
  return {
    ...base(ctx),
    action: 'ring',
    target: { kind: 'line', lineId: line.id, lineNumber: line.lineNumber, phoneId: phone.id, name: label },
    caller,
    hours: { open: true, timezone: DEFAULT_TIMEZONE, nextChangeAt: null },
    before: null,
    outOfHours: null,
    ring: {
      strategy: 'ring_all',
      ringSeconds: DEFAULT_RING_SECONDS,
      callWaiting: true,
      order: 'fixed',
      steps: [{ step: 1, seconds: DEFAULT_RING_SECONDS, memberEntryIds: leg.entryId ? [leg.entryId] : [], legs: [leg] }],
    },
    noAnswer: { kind: 'release' },
    recording: { record: false },
    skipped: [],
  };
}
