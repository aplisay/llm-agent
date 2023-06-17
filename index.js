require('dotenv').config();
const express = require('express');
const ws = require('ws');
const app = express();

const { createEndpoint } = require('@jambonz/node-client-ws');

const Application = require('./lib/application');

const port = process.env.WS_PORT || 4000;
const server = app.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});

const makeService = createEndpoint({ server });
const logger = require('pino')({
  level: process.env.LOGLEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});


appParameters = {
  logger,
  makeService
}

applications = [];

let servers = Application.listAgents().map(([name, info]) => {
  let application = new Application({ ...appParameters, agentName: name });
  return application.create().then(number => {
    logger.info({ application }, `Application created on number ${number}`);
    applications.push(application);
  })

})

process.on('beforeExit', cleanup); 

process.on('beforeExit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function cleanup() {
  logger.info({}, `beforeExit: ${applications.length} applications running`);
  applications.forEach(application => application.destroy());
}

