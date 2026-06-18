import { WebSocketServer } from 'ws';
import handlers from './handlers/index.js';
import { getChatSession } from './text-chat.js';
import parseurl from 'parseurl';

const createWsServer = ({ server, logger }, restrict) => {
  server.on('upgrade', async (req, socket, head) => {
    const url = parseurl(req);
    const [, type, id] = [...url.path.matchAll(/\/(progress|audio|chat)\/([0-9a-zA-Z-]*)$/g)][0] || [];
    logger.debug({ url, type, id }, `WS request received for ${url.path}`);

    // Text-agent chat sessions live in memory (no DB Instance) and are resolved
    // straight from the chat registry; voice progress/audio resolve via Instance.
    if (type === 'chat') {
      const session = id && getChatSession(id);
      if (session && (!restrict || restrict === 'chat')) {
        const wss = new WebSocketServer({ noServer: true });
        wss.on('connection', (ws) => session.handleChat(ws));
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else {
        logger.debug({ id }, `WS chat request but no session for ${url.path}`);
      }
      return;
    }

    const handler = id && await (await handlers()).fromInstance(id);
    const methods = handler && { progress: 'handleUpdates', audio: 'handleAudio' };
    if (handler && methods?.[type] && (!restrict || restrict === type)) {
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: type === 'audio' ? () => 'audio.jambonz.org' : undefined,
      });
      wss.on('connection', (ws) => handler[methods[type]](ws));
      wss.handleUpgrade(req, socket, head, (ws) => {
        logger.debug({ req, socket }, 'ws upgrade');
        wss.emit('connection', ws, req);
      });
    } else {
      logger.debug({ type, id }, `WS request but no path here ${url.path}`);
    }
  });
};

export default createWsServer;
