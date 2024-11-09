const { WebSocketServer } = require('ws');
const Handler = require('./handlers/handler');
const parseurl = require('parseurl');


const createWsServer = ({ server, logger }) => {
  server.on('upgrade', async (req, socket, head) => {
    let url = parseurl(req);
    let instanceId = url.path.replace(/\/progress\/([0-9a-zA-Z-]*)$/, '$1');
    let handler = instanceId && await Handler.fromInstance(instanceId);
    if (handler) {
      let wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws) => handler.handleUpdates(ws));
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    else {
      socket.destroy();
      logger.debug(`WS request received but no path here ${url.path}`);
    }

  });
};

module.exports = createWsServer;