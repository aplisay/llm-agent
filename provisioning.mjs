// The provisioning service: desk phones fetch their settings files from it.
// A process of its own, apart from the API server. See docs/phone-provisioning.md.
import dotenv from 'dotenv';
import logger from './lib/logger.js';
import { clearPlaceholders } from './lib/env-placeholders.js';
import { provisioningConfig, createProvisioningServer } from './lib/provisioning/server.js';

dotenv.config();
clearPlaceholders();

let config;
try {
  config = provisioningConfig();
} catch (err) {
  logger.fatal(`provisioning cannot start: ${err.message}`);
  process.exit(1);
}

const { databaseStarted, stopDatabase } = await import('./lib/database.js');
await databaseStarted;
const { phoneProvisioningReady } = await import('./lib/capabilities.js');
if (!phoneProvisioningReady()) {
  logger.fatal('provisioning cannot start: the database needs an upgrade (tools/agent-admin.js upgrade-db)');
  await stopDatabase?.();
  process.exit(1);
}
const { handleFetch } = await import('./lib/provisioning/service.js');

const server = createProvisioningServer(config, { handleFetch, logger });
server.listen(config.port, () => {
  logger.info({ port: config.port, mode: config.tls ? 'tls' : 'behind a proxy' }, 'provisioning service listening');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await stopDatabase?.();
      process.exit(0);
    });
  });
}
