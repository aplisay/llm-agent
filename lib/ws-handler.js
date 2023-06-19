const { WebSocketServer } = require('ws');
const parseurl = require('parseurl');


const endpoints = {};

const createEndpoint = (path, handler) => (endpoints[path] = handler);
const deleteEndpoint = (path) => (delete endpoints[path]);

const createWsServer = ({ server, logger }) => {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = parseurl(req);
    const handler = endpoints[url.path] || endpoints[`/${url.path}`];
    if (handler) {
      wss.on('connection', (ws) => handler(ws));
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });

    }
    else {
      logger.debug(`WS request received but no path here ${url.path}`);
    }

  });

  return ({ createEndpoint, deleteEndpoint });
};

module.exports = createWsServer;