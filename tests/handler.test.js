require('dotenv').config();
const handlers = require('../lib/handlers/');

describe(`handlers`, () => {
  
  test('Full list of handlers and models', () => {
    expect(Object.keys(handlers).length).toBe(3);
    expect(Object.values(handlers).map(h => h.availableModels).flat().length).toBe(20);
  });

  test('voices', async () => {
    for (const handler of handlers) {
      const voices = await handler.voices;
      expect(Object.keys(voices).length).toBeGreaterThan(0);
    }
  });
});