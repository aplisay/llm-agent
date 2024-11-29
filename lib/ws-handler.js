const { WebSocketServer } = require('ws');
const handlers = require('./handlers');
const parseurl = require('parseurl');


const createWsServer = ({ server, logger }, restrict) => {
  server.on('upgrade', async (req, socket, head) => {
    let url = parseurl(req);
    let path = url.path.matchAll(/\/(progress|audio)\/([0-9a-zA-Z-]*)$/g);
    let [, type, instanceId] = (path && [...path][0]) || [];
    let handler = instanceId && await handlers.fromInstance(instanceId);
    logger.debug({ url, type, instanceId, handler }, `WS request received for ${url.path}`);
    let types = handler && {
      progress: 'handleUpdates',
      audio: 'handleAudio'
    }
    if (handler && types?.[type] && (!restrict || restrict === type)) {
      let wss = new WebSocketServer({
        noServer: true,
        handleProtocols:
          type === 'audio'
          ? () => 'audio.jambonz.org' 
          : undefined
      });
      wss.on('connection', (ws) => handler[types[type]](ws));
      wss.handleUpgrade(req, socket, head, (ws) => {
        console.log({ req, socket }, 'ws upgrade');
        wss.emit('connection', ws, req);
      });
    }
    else {
      logger.debug({type,instanceId, req, socket, head}, `WS request received but no path here ${url.path}`);
    }

  });
};

module.exports = createWsServer;