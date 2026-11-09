import { listenPort } from '../lib/listen-port.js';

describe('listenPort', () => {
  test('defaults to 4000', () => {
    expect(listenPort({})).toBe(4000);
  });

  test('reads PORT, as container platforms set it', () => {
    expect(listenPort({ PORT: '8080' })).toBe('8080');
  });

  test('WS_PORT wins over PORT, so existing deploys keep their port', () => {
    expect(listenPort({ WS_PORT: '4000', PORT: '8080' })).toBe('4000');
  });
});
