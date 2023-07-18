const { WebSocketServer } = require('ws');
const parseurl = require('parseurl');


const endpoints = {};

const createEndpoint = (path, handler) => (endpoints[path] = handler);
const deleteEndpoint = (path) => (delete endpoints[path]);

const createWsServer = ({ server, logger }) => {

  let endpoints = {};

  const createEndpoint = (path, handler) => {
    endpoints[path] = handler;
  };
  const deleteEndpoint = (path) => (delete endpoints[path]);

  server.on('upgrade', (req, socket, head) => {
    let url = parseurl(req);
    let handler = endpoints[url.path];
    if (handler) {
      let wss = new WebSocketServer({ noServer: true });
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