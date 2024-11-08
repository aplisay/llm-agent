require('dotenv').config();
const { stopDatabase } = require('../lib/database');
const handlers = require('../lib/handlers/');

afterAll(async () => {
  await stopDatabase();
}, 60000);

describe(`handlers`, () => {

  test('Full list of handlers and models', () => {
    expect(Object.keys(handlers.implementations).length).toBe(3);
    expect(handlers.models.length).toBe(20);
  });

  test('voices', async () => {
    for (const handler of handlers.implementations) {
      const voices = await handler.voices;
      expect(Object.keys(voices).length).toBeGreaterThan(0);
    }
  });
});