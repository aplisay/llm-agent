/**
 * Removed directory entries and extensions are kept for 30 days so they can be
 * restored, then purged for good. The server runs the purge once a day.
 */
import { DirectoryEntry, Extension, ExtensionMember, PhonePerson, Line, Op, databaseStarted } from '../database.js';
import defaultLogger from '../logger.js';
import { phoneSystemReady } from '../capabilities.js';

export const KEEP_REMOVED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete entries and extensions removed before `before`, and the rows that
 * hang off them. Idempotent, so two servers running it at once is harmless.
 *
 * @returns {Promise<{ entries: number, extensions: number }>}
 */
export async function purgeRemoved({ before = new Date(Date.now() - KEEP_REMOVED_DAYS * DAY_MS), organisationId } = {}) {
  if (!phoneSystemReady()) return { entries: 0, extensions: 0 };
  const { sequelize } = Extension;
  return sequelize.transaction(async (transaction) => {
    const scope = organisationId ? { organisationId } : {};
    let entryIds = (await DirectoryEntry.findAll({
      where: { ...scope, deletedAt: { [Op.lt]: before } },
      attributes: ['id'],
      transaction,
    })).map((row) => row.id);
    const candidates = await Extension.findAll({
      where: { ...scope, [Op.or]: [{ deletedAt: { [Op.lt]: before } }, ...(entryIds.length ? [{ entryId: entryIds }] : [])] },
      attributes: ['id', 'entryId', 'deletedAt'],
      transaction,
    });
    // A line still on a removed extension means its SIP account is still there.
    // The line working-out removes both, so such an extension waits for that.
    const onLines = new Set(candidates.length
      ? (await Line.findAll({ where: { extensionId: candidates.map((row) => row.id) }, attributes: ['extensionId'], transaction })).map((row) => row.extensionId)
      : []);
    const extensionIds = candidates.filter((row) => row.deletedAt && !onLines.has(row.id)).map((row) => row.id);
    // An entry whose extension stays (live, or waiting) stays too: the extension refers to it.
    const kept = new Set(candidates.filter((row) => !extensionIds.includes(row.id)).map((row) => row.entryId));
    entryIds = entryIds.filter((id) => !kept.has(id));
    if (extensionIds.length) {
      await ExtensionMember.destroy({ where: { extensionId: extensionIds }, transaction });
      await Extension.destroy({ where: { id: extensionIds }, transaction });
    }
    if (entryIds.length) {
      await ExtensionMember.destroy({ where: { entryId: entryIds }, transaction });
      await PhonePerson.destroy({ where: { entryId: entryIds }, transaction });
      await DirectoryEntry.destroy({ where: { id: entryIds }, transaction });
    }
    return { entries: entryIds.length, extensions: extensionIds.length };
  });
}

/**
 * Run the purge once a day. Started by the server only (index.mjs), never by
 * importing this module, so a command-line tool does not delete anything.
 *
 * @returns {() => void} stop
 */
export function startDirectoryPurge({ intervalMs = DAY_MS, log = defaultLogger } = {}) {
  let timer = null;
  let stopped = false;
  const run = () => purgeRemoved()
    .then((counts) => { if (counts.entries || counts.extensions) log.info(counts, 'purged removed directory rows'); })
    .catch((err) => log.warn({ err: err?.message }, 'directory purge failed; it runs again tomorrow'));
  databaseStarted.then(() => {
    if (stopped) return;
    run();
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
