require('dotenv').config();
const logger = require('../lib/logger');
const Voices = require('../lib/voices');

let voices;
let list;

describe(`voices`, () => {
  test('Instatiate', () => {
    expect(voices = new Voices(logger)).toBeInstanceOf(Voices);
    expect(voices.clients).toHaveProperty('google');
    expect(voices.clients).toHaveProperty('deepgram');
  });

  test('listVoices', async () => {
    list = await voices.listVoices('en');
    expect(list).toHaveProperty('google');
    expect(list).toHaveProperty('elevenlabs');
    return expect(list).toHaveProperty('deepgram');

  });


});