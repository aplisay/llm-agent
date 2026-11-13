/**
 * Telling the SIP account of a desk phone line from every other
 * `phone_registrations` row. A line account (mode 'registrar', kind 'device')
 * is written only by the line reconciler and shown only under its phone, so
 * the phone-endpoint routes and lists must leave it out.
 */
import { Op } from 'sequelize';

/** A `where` fragment that leaves line accounts out. */
export const notADeviceLine = { [Op.or]: [{ kind: null }, { kind: { [Op.ne]: 'device' } }] };

export const isDeviceLine = (registration) => registration?.kind === 'device';
