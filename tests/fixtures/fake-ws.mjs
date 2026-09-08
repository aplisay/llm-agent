import { EventEmitter } from 'node:events';

// The slice of the `ws` WebSocket surface lib/text-chat.js touches, recording
// every frame the server sends so a test can assert on the protocol.
export class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = this.OPEN;
    this.frames = [];
  }

  send(json) {
    this.frames.push(JSON.parse(json));
  }

  // The server's liveness ping: answer at once, as a browser would.
  ping() {
    setImmediate(() => this.emit('pong'));
  }

  close() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.close();
  }

  /** What the browser does when the user types. */
  say(text) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'user', text })));
  }

  /** Frames of one type, in order. */
  ofType(type) {
    return this.frames.filter((f) => f.type === type);
  }

  /** Resolve when a frame satisfies `pred`; reject on timeout. */
  waitFor(pred, { timeoutMs = 20000, what = 'frame' } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const hit = this.frames.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }
}

export default FakeWs;
