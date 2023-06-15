require('dotenv').config({ path: `.env.${process.env.NODE_ENV}` });
const { createServer } = require('http');
const { createEndpoint } = require('@jambonz/node-client-ws');
const Gpt35 = require('./lib/gpt35');
const Palm2 = require('./lib/palm2');
const agent = require('./lib/agent');

const server = createServer();
const makeService = createEndpoint({server});
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

agent({ name: 'gpt35', llmClass: Gpt35, logger, makeService });
agent({ name: 'palm2', llmClass: Palm2, logger, makeService });

server.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});
