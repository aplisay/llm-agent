import dotenv from 'dotenv';
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
import { cleanHandlers } from './lib/handlers/index.js';

logger.info('starting up');
dotenv.config();


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
else if (process.env.NODE_ENV === 'feature') {
  apiDoc.servers.unshift({ url: `https://llm-agent-feature.aplisay.com/api` });
}
else if (process.env.NODE_ENV === 'staging') {
  apiDoc.servers.unshift({ url: `https://llm-agent-staging.aplisay.com/api` });
}

// CORS first — it must apply to the Better-Auth routes (mounted next) as well as
// the API. `set-auth-token` is exposed so the SPA can capture the bearer token
// from the cross-origin sign-in response.
server.use(cors({
  origin: [
    'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030', 'http://localhost:5001', /^https:\/\/([a-z0-9-]+\.)*aplisay\.com$/,
    'https://feature-registration-db--playground-next.netlify.app'
  ],
  allowedHeaders: ['Cookie', 'Link', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Link', 'set-auth-token'],
  credentials: true,
  preflightContinue: true,

}));

// Better-Auth (parallel to Firebase) must mount BEFORE express.json — its node
// handler reads the raw request body. Inert unless BETTER_AUTH_ENABLED=true.
const { auth: betterAuth } = await import('./lib/auth/index.js');
if (betterAuth) {
  const { toNodeHandler } = await import('better-auth/node');
  server.all('/api/auth/*', toNodeHandler(betterAuth));
  logger.info('mounted better-auth at /api/auth/*');
}

// Tariff decks are whole carrier rate sheets (100k+ prefix rows → tens of MB of
// JSON), so parse those with a much larger limit. Mounted BEFORE the global 5mb
// parser: body-parser marks the body parsed and the global parser then skips it,
// so every OTHER route keeps the tight 5mb cap.
server.use('/api/tariffs', express.json({ limit: '48mb' }));
server.use(express.json({ limit: '5mb' }));
const pino = PinoHttp({
  logger,
  // Never write credentials into Cloud Logging: /api/oauth-handoff (behind this
  // logger) is cookie-authenticated with the better-auth session cookie, and
  // every API request carries a bearer Authorization — the default req
  // serializer would log both verbatim.
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization'], censor: '[redacted]' },
});

server.use(pino);

// Rate limiters for abuse-prone / unauthenticated paths. Mounted BEFORE the auth
// middleware and express-openapi so they shed load ahead of any DB work or the
// route handler. (The /api/auth/* limiter is configured inside better-auth in
// lib/auth/index.js, mounted further up.)
const { signupLimiter, webhookLimiter, roomJoinLimiter, oauthHandoffLimiter } = await import('./middleware/rate-limit.js');
server.use('/api/users/signup', signupLimiter);              // global cap
server.use('/api/hooks', webhookLimiter);                    // per-IP
server.use('/api/rooms/:listenerId/join', roomJoinLimiter);  // per-IP, before auth

// OAuth → polite-ai BFF session hand-off (Google sign-in). Registered BEFORE the
// auth middleware: the browser arriving here is mid-OAuth and authenticates via
// its better-auth session cookie, not a bearer token. No-op when better-auth is
// disabled or no polite-ai origin is configured.
if (betterAuth) {
  const { default: mountOauthHandoff } = await import('./lib/auth/oauth-handoff.js');
  mountOauthHandoff(server, logger, { limiter: oauthHandoffLimiter });
}

// Import middleware dynamically based on environment
if (process.env.AUTHENTICATE_USERS === "NO") {
  const { default: initNoAuth } = await import('./middleware/no-auth.js');
  initNoAuth(server, logger);
} else {
  const { default: initAuth } = await import('./middleware/auth.js');
  initAuth(server, logger);
}

// Check for private API exposure flag (support multiple naming conventions)
const shouldExposePrivateApis = process.env.EXPOSE_PRIVATE_APIS === 'true' || process.env.EXPOSE_PRIVATE_APIS === '1';
// Create a path filter to exclude private endpoints when not exposed
const securityFilter = (req, res) => {
  // Hide all /agent-db* paths from Swagger output unless explicitly enabled
  if (!shouldExposePrivateApis && req?.apiDoc?.paths) {
    for (const path of Object.keys(req.apiDoc.paths)) {
      if (path.startsWith('/agent-db')) delete req.apiDoc.paths[path];
    }
  }
  logger.debug({ paths: req.apiDoc.paths, shouldExposePrivateApis }, 'after pathFilter');
  res.status(200).json(req.apiDoc);
};

openapi.initialize({
  app: server,
  apiDoc,
  exposeApiDocs: true,
  docsPath: "/api-docs",
  dependencies: { wsServer, logger, voices: new Voices(logger) },
  paths: './api/paths',
  promiseMode: true,
  errorMiddleware: (await import('./middleware/errors.js')).default,
  securityFilter
});

httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.debug({}, `beforeExit: applications running`);
  await cleanHandlers();
  logger.debug({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}

