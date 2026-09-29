import Ultravox from '../lib/models/ultravox.js';
import {
  requestedTtsSpeed,
  ultravoxSpeedOverrides,
  validateTtsSpeed,
} from '../lib/tts-speed.js';

/**
 * Portable `options.tts.speed` on the API side: validation, and the native
 * Ultravox `voiceOverrides` mapping. Mirrors agents/livekit/test/tts-speed.test.ts
 * and agents/pipecat/tests/test_tts_speed.py.
 */

const mockLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => mockLogger,
};

describe('options.tts.speed', () => {
  test('validation accepts unset and 0.25..2, refuses the rest', () => {
    for (const ok of [undefined, null, 0.25, 0.9, 1, 1.2, 2]) {
      expect(() => validateTtsSpeed(ok)).not.toThrow();
    }
    for (const bad of [0, 0.2, 2.5, -1, '1.2', NaN, true]) {
      expect(() => validateTtsSpeed(bad)).toThrow(/options\.tts\.speed/);
    }
  });

  test('1 and unset send nothing', () => {
    expect(requestedTtsSpeed({ tts: { speed: 1 } })).toBeUndefined();
    expect(requestedTtsSpeed({ tts: {} })).toBeUndefined();
    expect(requestedTtsSpeed(undefined)).toBeUndefined();
    expect(requestedTtsSpeed({ tts: { speed: 1.2 } })).toBe(1.2);
  });

  test.each([
    ['eleven_labs', { elevenLabs: { speed: 1.2 } }],
    ['cartesia', { cartesia: { generationConfig: { speed: 1.3 } } }],
    ['lmnt', { lmnt: { speed: 1.3 } }],
    ['google', { google: { speakingRate: 1.3 } }],
    ['inworld', { inworld: { speakingRate: 1.3 } }],
    ['respeecher', undefined],
    [undefined, undefined],
  ])('Ultravox voiceOverrides for %s', (provider, expected) => {
    expect(ultravoxSpeedOverrides(provider, 1.3)).toEqual(expected);
  });

  test('native vendorSpecific voiceOverrides pass through to the /calls body', () => {
    const voiceOverrides = { elevenLabs: { speed: 0.8 } };
    const model = new Ultravox({
      logger: mockLogger,
      user: 'test-user',
      prompt: 'p',
      options: { tts: { voice: 'Mark', speed: 1.2 }, vendorSpecific: { ultravox: { voiceOverrides } } },
      modelName: 'ultravox:ultravox/ultravox-v0.7',
    });
    expect(model.modelData.voiceOverrides).toEqual(voiceOverrides);
  });
});
