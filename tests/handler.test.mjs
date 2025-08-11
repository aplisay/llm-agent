import 'dotenv/config';
import { stopDatabase } from '../lib/database.js';
import handlers from '../lib/handlers/index.js';

afterAll(async () => {
  await stopDatabase();
}, 60000);

describe(`handlers`, () => {

  let implementations, models;

  test('Full list of handlers and models', async () => {
    let crypto = await import('crypto');
    implementations = (await handlers()).implementations;
    models = (await handlers()).models;
    expect(Object.keys(implementations).length).toBe(3);
    expect(models.length).toBe(21);
  });

  test('voices', async () => {
    for (const handler of implementations) {
      const voices = await handler.voices;
      expect(Object.keys(voices).length).toBeGreaterThan(0);
    }
  });
});