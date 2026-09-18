import { WebSocketServer } from 'ws';
import handlers from './handlers/index.js';
import parseurl from 'parseurl';

const createWsServer = ({ server, logger }, restrict) => {
  server.on('upgrade', async (req, socket, head) => {
    // A rejection from an async EventEmitter listener is an unhandledRejection
    // — Node's default KILLS the process, taking every live session with it.
    // fromInstance can now throw deterministically (driver constructors fail
    // closed on a missing provider key), so the whole body is guarded.
    try {
      await handleUpgrade({ req, socket, head, logger, restrict });
    } catch (err) {
      logger.error({ err, path: parseurl(req)?.path }, 'ws upgrade failed');
      try {
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        socket.destroy();
      } catch { /* socket already gone */ }
    }
  });
};

const handleUpgrade = async ({ req, socket, head, logger, restrict }) => {
  const url = parseurl(req);
  const [, type, id] = [...url.path.matchAll(/\/(progress|audio|chat)\/([0-9a-zA-Z-]*)$/g)][0] || [];
  logger.debug({ url, type, id }, `WS request received for ${url.path}`);

  // Text-agent chat sessions are rows in chat_sessions that ONE process holds
  // in memory at a time. The upgrade may land on any process: if this one
  // holds the session it attaches directly, otherwise it claims the row (from
  // nobody, from a dead process, or by asking the live owner to hand it over)
  // and carries the conversation on from the state the row holds. Voice
  // progress/audio resolve via Instance.
  if (type === 'chat') {
    // Imported lazily: text-chat pulls in the DB layer, and ws-handler is
    // imported by index.mjs *before* dotenv.config() runs — a static import
    // would evaluate database.js (which connects at import) before .env loads.
    const { probeChatSession, attachChatSession } = await import('./text-chat.js');
    const found = id && await probeChatSession(id);
    if (found && (!restrict || restrict === 'chat')) {
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws) => {
        attachChatSession(id, ws, { logger }).catch((err) => {
          logger.error({ err, id }, 'chat attach failed');
          try { ws.close(); } catch { /* already gone */ }
        });
      });
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      // Refuse the upgrade OUTRIGHT: leaving it unanswered parks the browser
      // WebSocket in CONNECTING, so a client probing a lapsed session (the
      // re-attach flow after the grace window) would burn its whole fallback
      // timeout instead of failing over immediately.
      logger.debug({ id }, `WS chat request but no session for ${url.path}`);
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
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
};

export default createWsServer;
