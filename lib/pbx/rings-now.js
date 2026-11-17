/**
 * What a call to an extension would ring at a given moment, phone by phone,
 * for the screen. Pure. It is the ring plan (lib/pbx/ring-plan.js) joined with
 * whether each line is registered, which sipedge mirrors into the database.
 *
 * Whether a phone is in a call is known only to call control, so a busy phone
 * shows as one that rings.
 */
import { buildRingPlan } from './ring-plan.js';
import { lineForExtension } from './snapshot.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function sentence(row) {
  const whose = row.name ? `${row.name}'s ${row.label}` : row.label;
  switch (row.state) {
    case 'not_connected': return `${whose} is offline.`;
    case 'do_not_ring': return `${whose} is set not to ring.`;
    case 'mobile_not_for_shared': return `${whose} rings only for their own extension.`;
    case 'no_line': return `${whose} has no key for this extension.`;
    default: return null;
  }
}

function summaryOf(result, plan) {
  switch (result.action) {
    case 'ring': {
      const ringing = result.rings.filter((row) => row.state === 'rings').length;
      const head = ringing ? `Rings ${plural(ringing, 'phone', 'phones')} now.` : 'No phone rings now.';
      return [head, ...result.rings.map(sentence).filter(Boolean)].join(' ');
    }
    case 'forward': return `Calls are sent on to ${plan.forward?.number}.`;
    case 'agent': return 'Calls go to an agent.';
    case 'connection': return 'Calls go to your own phone system.';
    default: return `Calls are not put through (${plan.reason}).`;
  }
}

/**
 * @param {object} index        indexSnapshot(snapshot)
 * @param {string} extensionId
 * @param {object} [opts]       `{ at }`, a Date. Default now
 * @returns {object|null}       null when the extension is not in the index
 */
export function ringsNow(index, extensionId, { at = new Date() } = {}) {
  const extension = index.extensions.get(extensionId);
  if (!extension) return null;
  const plan = buildRingPlan(index, { kind: 'extension', extensionId }, { now: at });
  const result = {
    extensionId,
    number: extension.number,
    name: index.entries.get(extension.entryId)?.name ?? extension.number,
    type: extension.type,
    at: at.toISOString(),
    open: plan.hours?.open ?? true,
    action: plan.action,
    rings: [],
    ...(plan.action === 'refuse' ? { reason: plan.reason } : {}),
    ...(plan.redirectedFrom ? { redirectedFrom: plan.redirectedFrom } : {}),
    ...(plan.forward ? { forward: { number: plan.forward.number } } : {}),
  };
  const about = (entryId, phoneId) => {
    const phone = index.phones.get(phoneId);
    return { entryId, name: index.entries.get(entryId)?.name ?? null, phoneId, label: phone?.label ?? '', kind: phone?.kind ?? null };
  };

  if (plan.action === 'ring') {
    let offset = 0;
    for (const step of plan.ring.steps) {
      for (const leg of step.legs) {
        if (leg.kind === 'external') {
          result.rings.push({ ...about(leg.entryId, leg.phoneId), number: leg.number, state: 'rings', afterSeconds: offset + (leg.delaySeconds ?? 0) });
          continue;
        }
        const line = index.lineById.get(leg.lineId);
        const registered = Boolean(leg.registeredHint);
        result.rings.push({
          ...about(leg.entryId, leg.phoneId),
          key: leg.key,
          lineNumber: leg.lineNumber,
          state: registered ? 'rings' : 'not_connected',
          afterSeconds: offset,
          ...(!registered && line?.endpoint?.lastSeenAt ? { since: line.endpoint.lastSeenAt } : {}),
        });
      }
      // A hunt rings one member after another.
      if (plan.ring.strategy === 'hunt') offset += step.seconds;
    }
    for (const skipped of plan.skipped) {
      const line = lineForExtension(index, skipped.phoneId, extension.id);
      result.rings.push({
        ...about(skipped.entryId, skipped.phoneId),
        ...(line ? { key: line.position, lineNumber: line.lineNumber } : {}),
        state: skipped.reason,
      });
    }
  }
  result.summary = summaryOf(result, plan);
  return result;
}
