/**
 * Runs the extension charge once, in a process of its own, for tests that
 * need several API processes on one database. Waits until RUN_AT (epoch ms)
 * so the processes start together, then prints the run's totals as JSON.
 */
const root = new URL('../../', import.meta.url).pathname;
const db = await import(`${root}lib/database.js`);
await db.databaseStarted;
const { runExtensionCharges } = await import(`${root}lib/extension-charge.js`);
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const runAt = Number(process.env.RUN_AT || 0);
if (runAt > Date.now()) await new Promise((resolve) => { setTimeout(resolve, runAt - Date.now()); });
const totals = await runExtensionCharges({ now: new Date(process.env.CHARGE_NOW || Date.now()), log: quiet });
process.stdout.write(`${JSON.stringify(totals)}\n`);
await db.stopDatabase();
process.exit(0);
