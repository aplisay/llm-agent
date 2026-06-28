import { describe, expect, test } from '@jest/globals';
import { Buffer } from 'node:buffer';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  GcmEncryptStream,
  GcmDecryptStream,
  deriveKey,
  generateKey,
  parseGcsPath,
  defaultRecordingBaseUrl,
  objectNameFor,
} from '../lib/recording/index.js';

const PLAINTEXT = Buffer.from(
  'OggS magic bytes plus arbitrary payload — round-trip must preserve every byte 🔐',
);

async function roundTrip(plaintext, key) {
  const enc = new GcmEncryptStream(key);
  const dec = new GcmDecryptStream(key);
  const cipherSink = new PassThrough();
  const plainSink = new PassThrough();

  const cipherChunks = [];
  cipherSink.on('data', (c) => cipherChunks.push(c));

  await pipeline(Readable.from([plaintext]), enc, cipherSink);
  const ciphertext = Buffer.concat(cipherChunks);

  const decryptedChunks = [];
  plainSink.on('data', (c) => decryptedChunks.push(c));
  await pipeline(Readable.from([ciphertext]), dec, plainSink);

  return {
    ciphertext,
    decrypted: Buffer.concat(decryptedChunks),
  };
}

describe('lib/recording — wire format', () => {
  test('encrypt → decrypt round-trips with derived key', async () => {
    const key = deriveKey('hunter2');
    const { ciphertext, decrypted } = await roundTrip(PLAINTEXT, key);
    expect(decrypted.equals(PLAINTEXT)).toBe(true);
    // Wire format = IV(12) + ciphertext + tag(16). With one plaintext chunk
    // of N bytes, GCM produces N ciphertext bytes plus 12+16 overhead.
    expect(ciphertext.length).toBe(PLAINTEXT.length + 12 + 16);
  });

  test('encrypt → decrypt round-trips with generated key', async () => {
    const { key, base64 } = generateKey();
    expect(Buffer.from(base64, 'base64').equals(key)).toBe(true);
    const { decrypted } = await roundTrip(PLAINTEXT, key);
    expect(decrypted.equals(PLAINTEXT)).toBe(true);
  });

  test('decrypt with wrong key fails', async () => {
    const enc = new GcmEncryptStream(deriveKey('right'));
    const out = new PassThrough();
    const parts = [];
    out.on('data', (c) => parts.push(c));
    await pipeline(Readable.from([PLAINTEXT]), enc, out);
    const ciphertext = Buffer.concat(parts);

    const wrongDec = new GcmDecryptStream(deriveKey('wrong'));
    const sink = new PassThrough();
    sink.resume();
    await expect(
      pipeline(Readable.from([ciphertext]), wrongDec, sink),
    ).rejects.toThrow();
  });

  test('deriveKey is deterministic and zero-pads short strings', () => {
    const a = deriveKey('abc');
    const b = deriveKey('abc');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    // First 3 bytes are the UTF-8 of "abc", the rest must be zero.
    expect(a.subarray(0, 3).toString('utf8')).toBe('abc');
    expect(a.subarray(3).every((b) => b === 0)).toBe(true);
  });

  test('deriveKey truncates strings longer than 32 bytes', () => {
    const long = 'x'.repeat(64);
    const k = deriveKey(long);
    expect(k.length).toBe(32);
    expect(k.toString('utf8')).toBe('x'.repeat(32));
  });

  test('parseGcsPath splits bucket and prefix', () => {
    expect(parseGcsPath('gs://my-bucket')).toEqual({ bucket: 'my-bucket', prefix: '' });
    expect(parseGcsPath('gs://my-bucket/foo')).toEqual({
      bucket: 'my-bucket',
      prefix: 'foo/',
    });
    expect(parseGcsPath('gs://my-bucket/foo/')).toEqual({
      bucket: 'my-bucket',
      prefix: 'foo/',
    });
  });

  test('parseGcsPath rejects non-gs URLs', () => {
    expect(() => parseGcsPath('s3://nope')).toThrow();
  });

  test('objectNameFor produces callId.ogg under prefix', () => {
    expect(objectNameFor('', 'abc-123')).toBe('abc-123.ogg');
    expect(objectNameFor('recordings/', 'abc-123')).toBe('recordings/abc-123.ogg');
  });

  test('defaultRecordingBaseUrl honours env override', () => {
    const original = process.env.RECORDING_STORAGE_PATH;
    try {
      process.env.RECORDING_STORAGE_PATH = 'gs://override-bucket/x';
      expect(defaultRecordingBaseUrl()).toBe('gs://override-bucket/x');
    } finally {
      if (original === undefined) delete process.env.RECORDING_STORAGE_PATH;
      else process.env.RECORDING_STORAGE_PATH = original;
    }
  });

  test('chunked input still round-trips', async () => {
    const key = deriveKey('chunky');
    const enc = new GcmEncryptStream(key);
    const cipherChunks = [];
    const cipherSink = new Writable({
      write(chunk, _enc, cb) {
        cipherChunks.push(chunk);
        cb();
      },
    });
    const pieces = [
      PLAINTEXT.subarray(0, 17),
      PLAINTEXT.subarray(17, 41),
      PLAINTEXT.subarray(41),
    ];
    await pipeline(Readable.from(pieces), enc, cipherSink);
    const ciphertext = Buffer.concat(cipherChunks);

    const dec = new GcmDecryptStream(key);
    const plainChunks = [];
    const plainSink = new Writable({
      write(chunk, _enc, cb) {
        plainChunks.push(chunk);
        cb();
      },
    });
    // Feed the ciphertext in three sub-chunks too.
    const ciphertextPieces = [
      ciphertext.subarray(0, 7),
      ciphertext.subarray(7, 64),
      ciphertext.subarray(64),
    ];
    await pipeline(Readable.from(ciphertextPieces), dec, plainSink);
    expect(Buffer.concat(plainChunks).equals(PLAINTEXT)).toBe(true);
  });
});
