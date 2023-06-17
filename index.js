require('dotenv').config();
const Application = require('./lib/application');
const { createEndpoint } = require('@jambonz/node-client-ws');
const { createServer } = require('http');

const server = createServer();
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
const port = process.env.WS_PORT || 4000;

app = {
  logger,
  makeService
}

applications = [];

let servers = Application.listAgents().map(([name, info]) => {
  let application = new Application({ ...app, agentName: name });
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

server.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});