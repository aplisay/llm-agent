require('dotenv').config();
const fs = require('fs');
const yaml = require('js-yaml');
const express = require('express');
const openapi = require('express-openapi');
const Voices = require('./lib/voices/');
const ws = require('ws');
const server = express();
const cors = require("cors");
const morgan = require("morgan");
const logger = require('./lib/logger');
const PinoHttp = require('pino-http');
const httpServer = require('http').createServer(server);
const { createEndpoint } = require('@jambonz/node-client-ws');
const makeService = createEndpoint({ server: httpServer, logger });
const wsServer = require('./lib/ws-handler')({ server: httpServer, logger });
const handlers = require('./lib/handlers');

let apiDoc;

// This is a bodge to fix the fact that some error conditions can cause the Axios request
//  structure to be returned in the error message, and this is circular, causing an exception
//  we should eradicate these anyway.
/*
server.set('json replacer', (() => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    return value;
  };
})());
*/



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


server.use(express.json());


server.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030', 'http://localhost:5001', 'https://llm.aplisay.com', 'https://llm.aplisay.uk', 'https://llm-backend.aplisay.com', 'https://llm.us.aplisay.com'],
  allowedHeaders: ['Cookie', 'Link', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Link',],
  credentials: true,

}));

const pino = PinoHttp({
  logger
});

server.use(pino);
process.env.AUTHENTICATE_USERS !== "NO" && require('./middleware/auth.js')(server, logger);

openapi.initialize({
  app: server,
  apiDoc,
  exposeApiDocs: true,
  docsPath: "/api-docs",
  dependencies: { makeService, wsServer, logger, voices: new Voices(logger) },
  paths: './api/paths',
  promiseMode: true,
  errorMiddleware: require('./middleware/errors.js')
});

httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanupAndExit);
process.once('SIGTERM', cleanupAndExit);
process.on('SIGUSR2', cleanupAndExit);

async function cleanup() {
  logger.info({}, `beforeExit: applications running`);
  await handlers.clean();
  logger.info({}, `cleanup: applications cleaned`);
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(-1);
}

