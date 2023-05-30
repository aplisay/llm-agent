require('dotenv').config({ path: `.env.${process.env.NODE_ENV}` });
const { createServer } = require('http');
const { createEndpoint } = require('@jambonz/node-client-ws');
const { llm } = require('./lib/chatgpt35');

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

llm({ logger, makeService });

server.listen(port, () => {
  logger.info(`Server listening at http://localhost:${port}`);
});
