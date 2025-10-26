import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase, Agent, Instance, PhoneNumber, PhoneRegistration, Call, TransactionLog, User, Organisation, AuthKey, Trunk, Op, Sequelize, databaseStarted, stopDatabase } from './setup/database-test-wrapper.js';
import handlers from '../lib/handlers/index.js';

beforeAll(async () => {
  await setupRealDatabase();
  dotenv.config();
}, 60000);

afterAll(async () => {
  await teardownRealDatabase();
}, 60000);

describe(`handlers`, () => {

  let implementations, models;

  test('Full list of handlers and models', async () => {
    let crypto = await import('crypto');
    implementations = (await handlers()).implementations;
    models = (await handlers()).models;
    expect(Object.keys(implementations).length).toBe(3);
    expect(models.length).toBe(22);
  });

  test('voices', async () => {
    for (const handler of implementations) {
      const voices = await handler.voices;
      expect(Object.keys(voices).length).toBeGreaterThan(0);
    }
  });
});