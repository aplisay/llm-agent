import {
  STT_FORMATTING_FIELDS,
  sttVendorName,
  validateSttFormatting,
} from '../lib/stt-formatting.js';

/**
 * `formatted` and the Deepgram options on the STT blocks: API validation.
 * The engine mapping is tested in agents/livekit/test/stt-formatting.test.ts and
 * agents/pipecat/tests/test_stt_formatting.py. See docs/stt-formatting.md.
 */

const refuses = (block, pattern, context) => {
  let err;
  try { validateSttFormatting(block, context); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(err.status).toBe(400);
  expect(err.message).toMatch(pattern);
};

describe('validateSttFormatting', () => {
  test('accepts the documented shapes', () => {
    for (const block of [
      undefined,
      null,
      {},
      { vendor: 'assemblyai', formatted: true },
      { vendor: 'cartesia', formatted: false },
      { formatted: true, smart_format: false, punctuate: true, numerals: true, no_delay: false },
      { vendor: 'deepgram', endpointing: 1500 },
      { vendor: 'deepgram/nova-3:en', endpointing: false },
      { endpointing: 10 },
      { endpointing: 10000 },
      { formatted: null, smart_format: null, endpointing: null },
    ]) {
      expect(() => validateSttFormatting(block)).not.toThrow();
    }
  });

  test('refuses wrong types', () => {
    refuses({ formatted: 'yes' }, /options\.stt\.formatted must be a boolean/);
    refuses({ smart_format: 1 }, /smart_format must be a boolean/);
    refuses({ no_delay: 'false' }, /no_delay must be a boolean/);
    refuses({ endpointing: true }, /endpointing must be a whole number/);
    refuses({ endpointing: 9 }, /endpointing must be a whole number/);
    refuses({ endpointing: 10001 }, /endpointing must be a whole number/);
    refuses({ endpointing: 1500.5 }, /endpointing must be a whole number/);
    refuses({ endpointing: '1500' }, /endpointing must be a whole number/);
  });

  test('refuses Deepgram options in a block that names another engine', () => {
    refuses({ vendor: 'assemblyai', smart_format: true }, /sets smart_format, which only Deepgram takes, but its vendor is "assemblyai"/);
    refuses({ vendor: 'cartesia/ink-whisper:en', endpointing: 1500, numerals: true }, /sets numerals, endpointing/);
    refuses({ vendor: 'google', punctuate: true }, /punctuate/, 'options.tts.output');
    // `formatted` is portable, so it is fine on any engine.
    expect(() => validateSttFormatting({ vendor: 'google', formatted: true })).not.toThrow();
  });

  test('names the block in every message', () => {
    refuses({ formatted: 1 }, /^options\.stt\.aux\.formatted/, 'options.stt.aux');
  });

  test('sttVendorName reads the engine from a scoped vendor string', () => {
    expect(sttVendorName('Deepgram/nova-3:en')).toBe('deepgram');
    expect(sttVendorName('assemblyai')).toBe('assemblyai');
    expect(sttVendorName(undefined)).toBeUndefined();
    expect(sttVendorName('')).toBeUndefined();
  });

  test('the side blocks allow every formatting field', () => {
    expect(STT_FORMATTING_FIELDS).toEqual(['formatted', 'smart_format', 'punctuate', 'numerals', 'no_delay', 'endpointing']);
  });
});
