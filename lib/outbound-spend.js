/**
 * How much an organisation has spent on outside calls since an instant: the
 * seam between the outbound policy's spend limits (lib/outbound-policy.js) and
 * the usage ledger. lib/outbound-authorisation.js calls it through its
 * `spendSource` model, so a test or a later source can replace it.
 *
 * Interim source: the costed, finalised usage rows that carry a destination
 * charge (`metadata.destinationRaw`), by their billing instant. Today only
 * agent legs on our chargeable trunks write those. Phone system legs write no
 * usage yet, so they count as nothing here until they do. The cost of a call in
 * progress is not known until it ends, so it is not counted either.
 *
 * @module lib/outbound-spend
 */
import { UsageRecord as DefaultUsageRecord } from './database.js';

/**
 * @param {{ organisationId: string, since: Date, until?: Date, transaction?: object }} params
 * @returns {Promise<number>} micros of a pound (1e-6 GBP)
 */
export async function outboundSpendSince({
  organisationId, since, until = new Date(), transaction,
}, { UsageRecord = DefaultUsageRecord } = {}) {
  const [row] = await UsageRecord.sequelize.query(
    `SELECT COALESCE(SUM(cost_micros), 0)::float8 AS spent FROM usage_records
      WHERE organisation_id = :organisationId AND finalised AND cost_micros IS NOT NULL
        AND billed_at >= :since AND billed_at < :until AND metadata ? 'destinationRaw'`,
    { replacements: { organisationId, since, until }, type: UsageRecord.sequelize.QueryTypes.SELECT, transaction },
  );
  return Number(row?.spent ?? 0);
}

export default outboundSpendSince;
