import 'dotenv/config';
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
import handlers from './lib/handlers/index.js';

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

openapi.initialize({
  app: server,
  apiDoc,
  exposeApiDocs: true,
  docsPath: "/api-docs",
  dependencies: { wsServer, logger, voices: new Voices(logger) },
  paths: './api/paths',
  promiseMode: true,
  errorMiddleware: (await import('./middleware/errors.js')).default
});

httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.debug({}, `beforeExit: applications running`);
  await handlers.clean();
  logger.debug({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}

