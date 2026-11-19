/**
 * options.backgroundAudio at agent save time: the pure validator, and the two
 * committed copies of each sound. See docs/background-audio.md.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { BACKGROUND_AUDIO_SOUNDS, validateBackgroundAudio } from '../lib/background-audio-options.js';
import { decodeWav } from '../lib/fallback-message/index.js';

describe('validateBackgroundAudio', () => {
  test.each([
    ['not set', undefined],
    ['null', null],
    ['true', true],
    ['false', false],
    ['an empty object', {}],
    ['enabled only', { enabled: false }],
    ['every field', { enabled: true, sound: 'office', volume: 'high', when: 'always', delayMs: 0 }],
    ['the typing sound', { sound: 'typing' }],
    ['thinking', { when: 'thinking' }],
    ['silent, low, short delay', { when: 'silent', volume: 'low', delayMs: 300 }],
    ['the longest delay', { delayMs: 10000 }],
    ['a fractional delay', { delayMs: 250.5 }],
  ])('accepts %s', (_name, value) => {
    expect(() => validateBackgroundAudio(value)).not.toThrow();
  });

  test.each([
    ['a string', 'office', /must be a boolean or an object/],
    ['a number', 1, /must be a boolean or an object/],
    ['an array', ['office'], /must be a boolean or an object/],
    ['enabled as a string', { enabled: 'yes' }, /enabled must be a boolean/],
    ['an unknown sound', { sound: 'cafe' }, /sound must be one of 'office', 'typing'/],
    ['an unknown volume', { volume: 'loud' }, /volume must be one of 'low', 'medium', 'high'/],
    ['a numeric volume', { volume: 0.5 }, /volume must be one of/],
    ['an unknown mode', { when: 'never' }, /when must be one of 'thinking', 'silent', 'always'/],
    ['a mode in the wrong case', { when: 'Always' }, /when must be one of/],
    ['a negative delay', { delayMs: -1 }, /delayMs must be a number between 0 and 10000/],
    ['a delay that is too long', { delayMs: 10001 }, /delayMs must be a number between 0 and 10000/],
    ['a delay as a string', { delayMs: '600' }, /delayMs must be a number/],
    ['a delay that is not finite', { delayMs: Infinity }, /delayMs must be a number/],
    ['a delay that is not a number', { delayMs: NaN }, /delayMs must be a number/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => validateBackgroundAudio(value)).toThrow(message);
  });
});

const asset = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)));

/** Peak and mean level in dBFS of a 16-bit PCM buffer. */
function levels(pcm) {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
  }
  const db = (value) => 20 * Math.log10(value / 32768);
  return { peak, peakDb: db(peak), rmsDb: db(Math.sqrt(sumSquares / (pcm.length / 2))) };
}

describe.each(BACKGROUND_AUDIO_SOUNDS)('the %s sound', (sound) => {
  const livekit = asset(`agents/livekit/assets/background/${sound}-16k.wav`);
  const pipecat = asset(`agents/pipecat/pipecat_aplisay/assets/background/${sound}-16k.wav`);

  // Each image copies only its own worker directory, so each worker has a copy.
  test('is the same file in both workers', () => {
    expect(livekit.equals(pipecat)).toBe(true);
  });

  test('is mono 16-bit PCM at 16 kHz, 10 to 30 s long, and does not clip', () => {
    const { pcm, sampleRate } = decodeWav(livekit);
    expect(sampleRate).toBe(16000);
    const seconds = pcm.length / 2 / sampleRate;
    expect(seconds).toBeGreaterThan(10);
    expect(seconds).toBeLessThan(30);
    expect(levels(pcm).peak).toBeLessThan(32767);
  });
});

describe('the office sound', () => {
  // The clip is Apache-2.0, which asks for its licence to travel with it.
  test('has its licence beside both copies', () => {
    const livekitLicence = asset('agents/livekit/assets/background/LICENCE-Apache-2.0.txt');
    const pipecatLicence = asset('agents/pipecat/pipecat_aplisay/assets/background/LICENCE-Apache-2.0.txt');
    expect(livekitLicence.toString()).toMatch(/Apache License\s+Version 2\.0/);
    expect(livekitLicence.equals(pipecatLicence)).toBe(true);
  });

  // The workers' volume levels assume a mean level of -20 dBFS.
  test('has a mean level of -20 dBFS', () => {
    const { rmsDb } = levels(decodeWav(asset('agents/livekit/assets/background/office-16k.wav')).pcm);
    expect(rmsDb).toBeGreaterThan(-20.5);
    expect(rmsDb).toBeLessThan(-19.5);
  });
});

describe('the typing sound', () => {
  // Set by its peak, not its mean level: see scripts/make-background-typing.sh.
  test('peaks at -1 dBFS', () => {
    const { peakDb } = levels(decodeWav(asset('agents/livekit/assets/background/typing-16k.wav')).pcm);
    expect(peakDb).toBeGreaterThan(-1.3);
    expect(peakDb).toBeLessThan(-0.7);
  });
});
