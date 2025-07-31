<<<<<<< HEAD
import dotenv from 'dotenv';
=======
import 'dotenv/config';
>>>>>>> 28b3218 (Refactor project to ESM)
import fs from 'fs';
import yaml from 'js-yaml';
import express from 'express';
import openapi from 'express-openapi';
import Voices from './lib/voices/index.js';
import cors from "cors";
import logger from './lib/logger.js';
import PinoHttp from 'pino-http';
import { createServer } from 'http';
import createWsServer from './lib/ws-handler.js';
<<<<<<< HEAD
import { cleanHandlers } from './lib/handlers/index.js';

logger.info('starting up');
dotenv.config();
logger.info({ env: process.env }, 'config done');

=======
import handlers from './lib/handlers/index.js';
>>>>>>> 28b3218 (Refactor project to ESM)

const server = express();
const httpServer = createServer(server);
const wsServer = createWsServer({ server: httpServer, logger });

let apiDoc;

try {
  apiDoc = yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8'));
}
catch (e) {
  logger.error(e, 'Couldn\'t load API spec');
  process.exit(1);
}

const port = process.env.WS_PORT || 4000;

if (process.env.NODE_ENV === 'development') {
  apiDoc.servers.unshift({ url: `http://localhost:${port}/api` });
}
else if (process.env.NODE_ENV === 'staging') {
  apiDoc.servers.unshift({ url: `https://llm-agent-staging.aplisay.com/api` });
}

server.use(express.json());

server.use(cors({
  origin: [
    'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030', 'http://localhost:5001', /https:\/\/.*\.aplisay\.com$/],
  allowedHeaders: ['Cookie', 'Link', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Link',],
  credentials: true,
  preflightContinue: true,

}));

const pino = PinoHttp({
  logger
});

server.use(pino);

// Import middleware dynamically based on environment
if (process.env.AUTHENTICATE_USERS === "NO") {
  const { default: initNoAuth } = await import('./middleware/no-auth.js');
  initNoAuth(server, logger);
} else {
  const { default: initAuth } = await import('./middleware/auth.js');
  initAuth(server, logger);
}

<<<<<<< HEAD
// Check for private API exposure flag (support multiple naming conventions)
const shouldExposePrivateApis = process.env.EXPOSE_PRIVATE_APIS === 'true' || process.env.EXPOSE_PRIVATE_APIS === '1';
// Create a path filter to exclude private endpoints when not exposed
const securityFilter = (req, res) => {
  // If private APIs should not be exposed, exclude endpoints with 'Agent Database' tag

  if (!shouldExposePrivateApis) {
    delete req.apiDoc.paths['/agent-db'];
  }
  logger.debug({ paths: req.apiDoc.paths, shouldExposePrivateApis }, 'after pathFilter');
  res.status(200).json(req.apiDoc);
};

=======
>>>>>>> 28b3218 (Refactor project to ESM)
openapi.initialize({
  app: server,
  apiDoc,
  exposeApiDocs: true,
  docsPath: "/api-docs",
  dependencies: { wsServer, logger, voices: new Voices(logger) },
  paths: './api/paths',
  promiseMode: true,
<<<<<<< HEAD
  errorMiddleware: (await import('./middleware/errors.js')).default,
  securityFilter
=======
  errorMiddleware: (await import('./middleware/errors.js')).default
>>>>>>> 28b3218 (Refactor project to ESM)
});

httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.debug({}, `beforeExit: applications running`);
<<<<<<< HEAD
  await cleanHandlers();
=======
  await handlers.clean();
>>>>>>> 28b3218 (Refactor project to ESM)
  logger.debug({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}

