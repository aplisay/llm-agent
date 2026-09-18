/**
 * Unit tests for the shared fallback-message cache layer
 * (`lib/fallback-message/`). The cross-runtime half of the contract is proved
 * in `fallback-message-cross-language.test.mjs`; this file is the always-on
 * safety net for the JS side.
 */
import { describe, expect, test } from '@jest/globals';
import {
  decodeWav,
  defaultFallbackMessageBaseUrl,
  encodeWav,
  fallbackMessageKey,
  objectNameForKey,
  parseGcsPath,
  resolveFallbackMessage,
} from '../lib/fallback-message/index.js';

describe('resolveFallbackMessage', () => {
  test('text alone is the minimal form', () => {
    expect(resolveFallbackMessage({ text: 'we are busy' }, {})).toMatchObject({
      text: 'we are busy',
    });
  });

  test('a bare string is rejected, not treated as shorthand', () => {
    // One shape to document, validate, and read. The write-time validation in
    // lib/database.js refuses a string outright.
    expect(resolveFallbackMessage('we are busy', {})).toBeNull();
  });

  test('an array is rejected too', () => {
    expect(resolveFallbackMessage(['we are busy'], {})).toBeNull();
  });

  test('text is trimmed and blank text resolves to null', () => {
    expect(resolveFallbackMessage({ text: '  hi  ' }, {}).text).toBe('hi');
    expect(resolveFallbackMessage({ text: '   ' }, {})).toBeNull();
    expect(resolveFallbackMessage({}, {})).toBeNull();
    expect(resolveFallbackMessage(null, {})).toBeNull();
    expect(resolveFallbackMessage(undefined, {})).toBeNull();
  });

  test('unstated tts settings fall back to the agent options', () => {
    const resolved = resolveFallbackMessage(
      { text: 'hi' },
      { tts: { vendor: 'elevenlabs', voice: 'Dominus', language: 'en-GB' } },
    );
    expect(resolved).toEqual({
      text: 'hi',
      vendor: 'elevenlabs',
      voice: 'Dominus',
      language: 'en-GB',
    });
  });

  test('stated tts settings win, so the announcement can use a healthy vendor', () => {
    const resolved = resolveFallbackMessage(
      { text: 'hi', vendor: 'deepgram/aura-2', voice: 'thalia' },
      { tts: { vendor: 'elevenlabs', voice: 'Dominus', language: 'en-GB' } },
    );
    expect(resolved).toMatchObject({
      vendor: 'deepgram/aura-2',
      voice: 'thalia',
      // Unstated fields still inherit.
      language: 'en-GB',
    });
  });
});

describe('resolveFallbackMessage — realtime agents', () => {
  // A realtime speech-to-speech agent's options.tts names a timbre of the
  // MODEL, not a TTS. Inheriting it would hand the TTS builder a vendor of
  // "ultravox", which does not degrade — it throws — so the announcement that
  // exists to cover the model failing would itself fail.
  const realtimeOptions = {
    tts: { vendor: 'ultravox', voice: 'Svetlana', language: 'en-GB' },
  };

  test('does not inherit the model voice or vendor', () => {
    const resolved = resolveFallbackMessage({ text: 'busy' }, realtimeOptions, {
      inheritAgentTts: false,
    });
    expect(resolved.vendor).toBeUndefined();
    expect(resolved.voice).toBeUndefined();
  });

  test('still inherits language, which is portable across model and TTS', () => {
    const resolved = resolveFallbackMessage({ text: 'busy' }, realtimeOptions, {
      inheritAgentTts: false,
    });
    expect(resolved.language).toBe('en-GB');
  });

  test('an explicit TTS override is kept — the whole point for a realtime agent', () => {
    const resolved = resolveFallbackMessage(
      { text: 'busy', vendor: 'elevenlabs', voice: 'Rachel' },
      realtimeOptions,
      { inheritAgentTts: false },
    );
    expect(resolved).toMatchObject({ vendor: 'elevenlabs', voice: 'Rachel', language: 'en-GB' });
  });

  test('the same words resolve differently for a realtime and a pipeline agent', () => {
    // Different audio, so they must not share a cache entry.
    const realtime = resolveFallbackMessage({ text: 'busy' }, realtimeOptions, {
      inheritAgentTts: false,
    });
    const pipeline = resolveFallbackMessage({ text: 'busy' }, realtimeOptions, {
      inheritAgentTts: true,
    });
    expect(fallbackMessageKey(realtime)).not.toBe(fallbackMessageKey(pipeline));
  });
});

describe('fallbackMessageKey', () => {
  test('is stable for identical input', () => {
    const a = resolveFallbackMessage({ text: 'hi' }, {});
    const b = resolveFallbackMessage({ text: 'hi' }, {});
    expect(fallbackMessageKey(a)).toBe(fallbackMessageKey(b));
  });

  test('changes when any hashed input changes — this is the invalidation', () => {
    const base = { text: 'hi', vendor: 'v', voice: 'x', language: 'en' };
    const key = fallbackMessageKey(base);
    for (const field of ['text', 'vendor', 'voice', 'language']) {
      expect(fallbackMessageKey({ ...base, [field]: 'different' })).not.toBe(key);
    }
  });

  test('a value containing the field separator cannot collide with a field split', () => {
    expect(fallbackMessageKey({ text: 't', voice: 'a|b' })).not.toBe(
      fallbackMessageKey({ text: 't', voice: 'a', language: 'b' }),
    );
  });

  test('is 32 lowercase hex characters', () => {
    expect(fallbackMessageKey({ text: 'hi' })).toMatch(/^[0-9a-f]{32}$/);
  });

  test('refuses a message with no text', () => {
    expect(() => fallbackMessageKey({ text: '' })).toThrow(/must have text/);
  });
});

describe('storage paths', () => {
  const withEnv = (env, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };

  test('defaults to the llm-voice bucket under a per-environment prefix', () => {
    withEnv(
      { NODE_ENV: 'production', RECORDING_STORAGE_PATH: undefined, FALLBACK_MESSAGE_STORAGE_PATH: undefined },
      () => {
        expect(defaultFallbackMessageBaseUrl()).toBe('gs://llm-voice/production-fallback-messages');
      },
    );
  });

  test('follows the recordings bucket when one is configured', () => {
    withEnv(
      { NODE_ENV: 'staging', RECORDING_STORAGE_PATH: 'gs://acme-media/staging-recordings', FALLBACK_MESSAGE_STORAGE_PATH: undefined },
      () => {
        // Same bucket, never the recordings prefix.
        expect(defaultFallbackMessageBaseUrl()).toBe('gs://acme-media/staging-fallback-messages');
      },
    );
  });

  test('an explicit override wins over both', () => {
    withEnv(
      { RECORDING_STORAGE_PATH: 'gs://acme-media/prod-recordings', FALLBACK_MESSAGE_STORAGE_PATH: 'gs://elsewhere/msgs' },
      () => {
        expect(defaultFallbackMessageBaseUrl()).toBe('gs://elsewhere/msgs');
      },
    );
  });

  test('object names are <prefix><key>.wav', () => {
    const { bucket, prefix } = parseGcsPath('gs://llm-voice/development-fallback-messages');
    expect(bucket).toBe('llm-voice');
    expect(objectNameForKey(prefix, 'deadbeef')).toBe('development-fallback-messages/deadbeef.wav');
  });
});

describe('wav', () => {
  const pcm = Buffer.alloc(640);
  pcm.writeInt16LE(12345, 0);
  pcm.writeInt16LE(-12345, 638);

  test('round-trips samples and rate', () => {
    const decoded = decodeWav(encodeWav(pcm, 24000));
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.pcm.equals(pcm)).toBe(true);
  });

  test('reads a payload with a chunk ahead of data, as some vendors emit', () => {
    const wav = encodeWav(pcm, 16000);
    // Splice an odd-length LIST chunk (plus its pad byte) before `data`.
    const list = Buffer.alloc(8 + 5);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(5, 4);
    const spliced = Buffer.concat([
      wav.subarray(0, 36),
      list,
      Buffer.alloc(1),
      wav.subarray(36),
    ]);
    expect(decodeWav(spliced).pcm.equals(pcm)).toBe(true);
  });

  test('a truncated payload yields the bytes present, not a phantom length', () => {
    const wav = encodeWav(pcm, 16000);
    const truncated = wav.subarray(0, wav.length - 100);
    expect(decodeWav(truncated).pcm.length).toBe(pcm.length - 100);
  });

  test('rejects payloads it cannot honestly decode', () => {
    expect(() => decodeWav(Buffer.alloc(64))).toThrow(/not a RIFF/);
    expect(() => decodeWav(Buffer.alloc(4))).toThrow(/too short/);
  });
});
