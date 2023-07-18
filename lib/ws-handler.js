const { WebSocketServer } = require('ws');
const parseurl = require('parseurl');



const createWsServer = ({ server, logger }) => {

  let endpoints = {};

  const createEndpoint = (path, handler) => {
    endpoints[path] = handler;
    logger.info({ path, handler, endpointKeys: Object.keys(endpoints) }, 'creating endpoint');
  };
  const deleteEndpoint = (path) => (delete endpoints[path]);

  server.on('upgrade', (req, socket, head) => {
    let url = parseurl(req);
    let handler = endpoints[url.path];
    logger.info({ url, endpointKeys: Object.keys(endpoints), handler: typeof handler }, 'newWs Connect');
    if (handler) {
      let wss = new WebSocketServer({ noServer: true });
      logger.info({ h: !!handler }, 'WS handling ');
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