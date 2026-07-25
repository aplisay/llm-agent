import { getAccent } from '../lib/voices/xilabs.js';

describe('XiLabs accent parsing', () => {
  test('maps a complete accent name without a decorator', () => {
    expect(getAccent('british')).toEqual({ language: 'en-GB', decorator: '' });
  });

  test('keeps the unmatched suffix as the decorator', () => {
    expect(getAccent('brit')).toEqual({ language: 'en-GB', decorator: 'ish' });
  });

  test('treats regular-expression characters as plain input', () => {
    expect(getAccent('[')).toEqual({ language: 'en-US', decorator: '' });
  });
});
