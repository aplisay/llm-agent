/**
 * The outbound trunks that phone system legs leave by but that are not
 * flagged `chargeable`, and are not a customer's registration: the trunks of
 * the phone system organisations' numbers, and `APLISAY_OUTBOUND_TRUNK_ID`.
 *
 * A leg on one of these is not charged and does not pass the organisation's
 * outbound policy (lib/outbound-authorisation.js), so each platform trunk
 * must be flagged. Shown by `yarn doctor` and logged at start.
 *
 * Imports no database code, so the doctor can use it with its own client.
 *
 * @module lib/outbound-trunk-check
 */

/**
 * @param {(sql: string, params: object) => Promise<object[]>} query runs SQL with named parameters (`:name`)
 * @returns {Promise<Array<{ id: string, name: string|null, numbers: number, reason: string }>>}
 */
export async function unflaggedPhoneSystemTrunks(query, { env = process.env } = {}) {
  const rows = await query(
    `SELECT t.id, t.name, COUNT(n.number)::int AS numbers
       FROM trunks t
       JOIN phone_numbers n ON n.aplisay_id = t.id
       JOIN organisations o ON o.id = n.organisation_id
      WHERE t.chargeable = false AND o.capabilities @> '["phoneSystem"]'::jsonb
        AND COALESCE(t.flags->>'provider', '') <> 'registration'
      GROUP BY t.id, t.name
      ORDER BY t.id`,
    {},
  );
  const found = rows.map((row) => ({ id: row.id, name: row.name, numbers: Number(row.numbers), reason: 'phone system numbers use it' }));
  const fallback = env.APLISAY_OUTBOUND_TRUNK_ID?.trim();
  if (fallback && !found.some((row) => row.id === fallback)) {
    const [trunk] = await query(
      `SELECT id, name FROM trunks WHERE id = :id AND chargeable = false AND COALESCE(flags->>'provider', '') <> 'registration'`,
      { id: fallback },
    );
    if (trunk) found.push({ id: trunk.id, name: trunk.name, numbers: 0, reason: 'it is APLISAY_OUTBOUND_TRUNK_ID' });
  }
  return found;
}
