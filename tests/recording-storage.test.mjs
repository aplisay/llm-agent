// Recording storage back ends (lib/recording/storage.js): the selection rules,
// a local-disk round trip through the real upload and decrypt streams, and the
// S3 signer against the AWS documentation example.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import {
  recordingStorageConfig,
  openRecordingStore,
  signS3Request,
  uploadEncryptedOgg,
  GcmDecryptStream,
} from '../lib/recording/index.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rec-store-'));

describe('recordingStorageConfig', () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  test('unset with no Google credentials: recording is off', () => {
    process.chdir(tempDir()); // no credentials/google.json here
    expect(recordingStorageConfig({})).toEqual({ enabled: false, reason: 'RECORDING_STORAGE_PATH is unset' });
  });

  test('unset with Google credentials keeps the old default bucket', () => {
    for (const env of [{ GOOGLE_APPLICATION_CREDENTIALS: 'credentials/google.json' }, { K_SERVICE: 'llm-agent' }, { GOOGLE_CREDENTIAL: '{}' }]) {
      expect(recordingStorageConfig({ ...env, NODE_ENV: 'production' })).toEqual({
        enabled: true, backend: 'gcs', baseUrl: 'gs://llm-voice/production-recordings', legacyDefault: true,
      });
    }
  });

  test('a non-empty credentials/google.json in the working directory counts as Google credentials', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'credentials'));
    fs.writeFileSync(path.join(dir, 'credentials', 'google.json'), '{}');
    process.chdir(dir);
    expect(recordingStorageConfig({}).enabled).toBe(true);
  });

  test('schemes', () => {
    expect(recordingStorageConfig({ RECORDING_STORAGE_PATH: 'gs://b/p' })).toMatchObject({ enabled: true, backend: 'gcs' });
    expect(recordingStorageConfig({ RECORDING_STORAGE_PATH: 'file:///data/rec' })).toMatchObject({ enabled: true, backend: 'file' });
    expect(recordingStorageConfig({ RECORDING_STORAGE_PATH: 's3://b/p' })).toMatchObject({ enabled: false, reason: 'missing S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY' });
    expect(recordingStorageConfig({ RECORDING_STORAGE_PATH: 's3://b/p', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' })).toMatchObject({ enabled: true, backend: 's3' });
    expect(recordingStorageConfig({ RECORDING_STORAGE_PATH: '/data/rec' }).enabled).toBe(false);
  });
});

describe('local-disk store', () => {
  test('upload, size, read back, decrypt and delete', async () => {
    const dir = tempDir();
    const source = path.join(tempDir(), 'audio.ogg');
    const audio = Buffer.from('OggS fake audio '.repeat(1000));
    fs.writeFileSync(source, audio);

    const result = await uploadEncryptedOgg({ localPath: source, callId: 'call-1', baseUrl: `file://${dir}` });
    expect(result.gcsObject).toBe('call-1.ogg');
    expect(fs.existsSync(source)).toBe(false);

    const store = await openRecordingStore({ RECORDING_STORAGE_PATH: `file://${dir}` });
    expect(await store.size('call-1.ogg')).toBe(audio.length + 12 + 16);
    const chunks = [];
    await pipeline(
      store.createReadStream('call-1.ogg'),
      new GcmDecryptStream(Buffer.from(result.serverGeneratedKey, 'base64')),
      new Writable({ write(chunk, _e, done) { chunks.push(chunk); done(); } }),
    );
    const decrypted = Buffer.concat(chunks);
    expect(decrypted.length).toBe(audio.length);
    expect(decrypted.equals(audio)).toBe(true);

    await store.delete('call-1.ogg');
    expect(fs.existsSync(path.join(dir, 'call-1.ogg'))).toBe(false);
    await expect(store.size('../outside.ogg')).rejects.toThrow(/outside the store/);
  });
});

describe('signS3Request', () => {
  test('matches the GET Object example in the AWS Signature Version 4 documentation', () => {
    const headers = signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      headers: { Range: 'bytes=0-9' },
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});
