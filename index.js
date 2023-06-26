require('dotenv').config();
const express = require('express');
const ws = require('ws');
const server = express();
const cors = require("cors");
const morgan = require("morgan");
const logger = require('./lib/logger');
const PinoHttp = require('pino-http');
const httpServer = require('http').createServer(server);
const { createEndpoint } = require('@jambonz/node-client-ws');
const makeService = createEndpoint({ server: httpServer });
const wsServer = require('./lib/ws-handler')({ server: httpServer, logger });
const api = require("./handlers/api")({ makeService, wsServer, logger });

const Application = require('./lib/application');

const port = process.env.WS_PORT || 4000;


server.use(express.json());

server.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5001', 'https://llm.aplisay.com', 'https://llm.aplisay.uk', 'https://llm-backend.aplisay.com'],
  allowedHeaders: ['Cookie', 'Link', 'Content-Type'],
  exposedHeaders: ['Link',],
  credentials: true,

}));

const pino = PinoHttp({
  level: process.env.LOGLEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  },
  serializers: {
    req: (req) => {
      let session = req.raw;
      //let session = res.status !== 200 && req.raw.session;
      return ({
        method: req.method,
        url: req.url,
        //session: req.raw.session,
      });
    },
  },
});

server.use(pino);

/**
 * @swagger
 * /api/agents:
 *   get:
 *     summary: Retrieve a list of current agents
 *     description: Get all the existing agents known to the server
 *   post:
 *     summary: Create a new agent
 *     description: Create a new agent on the LLM and link it to a free phone number on the Jambonz instance
 *   put:
 *     summary: Update an agent
 *     description: Change the prompt or options on an existing agent
 *   delete:
 *     summary: Delete an agent
 *     description: Delete an agent and free up the number on the underlying Jambonz instance.
*/
server.get("/api/agents", api.agentList);
server.post("/api/agents", api.agentCreate);
server.put("/api/agents/:id", api.agentUpdate);
server.delete("/api/agents/:id", api.agentDelete);



appParameters = {
  logger,
  makeService
}





httpServer.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

process.on('SIGINT', cleanup);
process.once('SIGTERM', function () {
  cleanup().then(() => {
    process.kill(process.pid, 'SIGKILL');
  });
});
process.on('SIGUSR2', function () {
  cleanup().then(() => {
    process.kill(process.pid, 'SIGKILL');
  });
});
async function cleanup() {
  logger.info({}, `beforeExit: applications running`);
  await Application.clean();
}

