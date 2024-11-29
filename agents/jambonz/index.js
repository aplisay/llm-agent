require('dotenv').config();
const Application = require('./lib/application');
const logger = require('./agent-lib/logger');
const express = require('express');
const server = express();
const httpServer = require('http').createServer(server);
require('./agent-lib/ws-handler')({ server: httpServer, logger }, 'audio');
const { createEndpoint } = require('@jambonz/node-client-ws');
const makeService = createEndpoint({ server: httpServer });
const { JAMBONZ_PORT: port = 8080, JAMBONZ_APPLICATION_PATH: path = '/jambonz/application', JAMBONZ_AGENT_NAME: host} = process.env;

httpServer.listen(port, () => {
  logger.info(`Jambonz listening at http://localhost:${port}`);
});

const socket = makeService({ path });
const application = new Application({ socket, host, path, logger });
application.loadNumbers();

server.get('/ping', (req, res) => {
  logger.debug({}, `ping`);
  res.send('pong');
});



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

