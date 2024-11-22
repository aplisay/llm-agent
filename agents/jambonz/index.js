require('dotenv').config();
const Application = require('./lib/application');
const logger = require('./agent-lib/logger');
const server = require('http').createServer();
require('./agent-lib/ws-handler')({ server, logger }, 'audio');
const { createEndpoint } = require('@jambonz/node-client-ws');
const makeService = createEndpoint({ server });
const { JAMBONZ_PORT: port = 8080, JAMBONZ_APPLICATION_PATH: path = '/jambonz/application', JAMBONZ_AGENT_NAME: host} = process.env;

server.listen(port, () => {
  logger.info(`Jambonz listening at http://localhost:${port}`);
});

const socket = makeService({ path });
const application = new Application({ socket, host, path, logger });
application.loadNumbers();

process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.debug({}, `beforeExit: applications running`);
  logger.debug({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}

