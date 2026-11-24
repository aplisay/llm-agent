// One more API process for tests/pbx-resync.test.mjs: at a shared instant it
// takes the due phones of one organisation and prints their device ids.
const db = await import(`${process.cwd()}/lib/database.js`);
await db.databaseStarted;
const { claimDueResyncs } = await import(`${process.cwd()}/lib/pbx/resync.js`);
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
while (Date.now() < Number(process.env.CLAIM_AT)) await new Promise((resolve) => setTimeout(resolve, 2));
const phones = await claimDueResyncs({ organisationId: process.env.CLAIM_ORGANISATION, log });
process.stdout.write(`TAKEN ${JSON.stringify(phones.map((phone) => phone.deviceId))}\n`);
await db.stopDatabase?.();
process.exit(0);
