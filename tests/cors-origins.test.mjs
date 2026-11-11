import { corsOrigins } from '../lib/cors-origins.js';

const allows = (list, origin) => list.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));

describe('corsOrigins', () => {
  test('the built-in list is kept when CORS_ORIGINS is unset', () => {
    const list = corsOrigins({});
    expect(allows(list, 'http://localhost:3000')).toBe(true);
    expect(allows(list, 'https://next.aplisay.com')).toBe(true);
    expect(allows(list, 'https://app.example.com')).toBe(false);
  });

  test('CORS_ORIGINS adds origins, trimmed and without a trailing slash', () => {
    const list = corsOrigins({ CORS_ORIGINS: ' https://app.example.com/ , http://10.0.0.5:8080,, ' });
    expect(allows(list, 'https://app.example.com')).toBe(true);
    expect(allows(list, 'http://10.0.0.5:8080')).toBe(true);
    expect(allows(list, 'http://localhost:3000')).toBe(true);
    expect(allows(list, 'https://other.example.com')).toBe(false);
  });
});
