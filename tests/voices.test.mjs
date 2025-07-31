import 'dotenv/config';
import logger from '../lib/logger.js';
import Voices from '../lib/voices/index.js';

let voices;
let list;

describe(`voices`, () => {
  test('Instatiate', () => {
    expect(voices = new Voices(logger)).toBeInstanceOf(Voices);
    expect(Voices.services).toHaveProperty('google');
    expect(Voices.services).toHaveProperty('deepgram');
  });

  test('listVoices', async () => {
    list = await voices.listVoices('en');
    expect(list).toHaveProperty('google');
    expect(list).toHaveProperty('elevenlabs');
    return expect(list).toHaveProperty('deepgram');

  }, 20000);


});