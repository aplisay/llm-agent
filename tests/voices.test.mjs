import dotenv from 'dotenv';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

import logger from '../lib/logger.js';
import Voices from '../lib/voices/index.js';

let voices;
let list;

beforeAll(async () => {
  await setupRealDatabase();
  dotenv.config();
}, 60000);

afterAll(async () => {
  await teardownRealDatabase();
}, 60000);

describe(`voices`, () => {
  test('Instatiate', async () => {
    expect(voices = new Voices(logger)).toBeInstanceOf(Voices);
    expect(await Voices.services()).toHaveProperty('google');
    expect(await Voices.services()).toHaveProperty('deepgram');
  });

  test('listVoices', async () => {
    list = await voices.listVoices('en');
    expect(list).toHaveProperty('google');
    expect(list).toHaveProperty('elevenlabs');
    return expect(list).toHaveProperty('deepgram');

  }, 20000);


});