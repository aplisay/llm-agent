import dotenv from 'dotenv';
import ws_handler from './agent-lib/ws-handler.js';
import { createEndpoint } from '@jambonz/node-client-ws';
import logger from './agent-lib/logger.js';
import express from 'express';
import { createServer } from 'http';

dotenv.config();

import('./lib/application.js').then(({ default: Application }) => {
  const server = express();
  const httpServer = createServer(server);

  ws_handler({ server: httpServer, logger }, 'audio');

  const makeService = createEndpoint({ server: httpServer });
  const { JAMBONZ_PORT: port = 8080, JAMBONZ_APPLICATION_PATH: path = '/jambonz/application', JAMBONZ_AGENT_NAME: host } = process.env;

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
}).catch(err => {
  logger.error(err, 'error loading application');
  cleanup(1);
});



process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.debug({}, `beforeExit: applications running`);
  logger.debug({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit(signal, code) {
  await cleanup();
  process.exit(code || -1);
}

