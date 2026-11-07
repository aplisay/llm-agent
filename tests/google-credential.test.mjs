import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeGoogleCredential } from '../lib/google-credential.js';

const SA = '{"type":"service_account","project_id":"test"}';
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gcred-'));

describe('writeGoogleCredential', () => {
  test('writes GOOGLE_CREDENTIAL to the GOOGLE_APPLICATION_CREDENTIALS path, mode 0600', () => {
    const target = path.join(tempDir(), 'credentials', 'google.json');
    expect(writeGoogleCredential({ GOOGLE_APPLICATION_CREDENTIALS: target, GOOGLE_CREDENTIAL: SA }))
      .toEqual({ status: 'written', path: target, bytes: SA.length });
    expect(fs.readFileSync(target, 'utf8')).toBe(SA);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('accepts GOOGLE_APPLICATION_CREDENTIALS_JSON', () => {
    const target = path.join(tempDir(), 'google.json');
    expect(writeGoogleCredential({ GOOGLE_APPLICATION_CREDENTIALS: target, GOOGLE_APPLICATION_CREDENTIALS_JSON: SA }).status)
      .toBe('written');
  });

  test('leaves a file baked into the image alone', () => {
    const target = path.join(tempDir(), 'google.json');
    fs.writeFileSync(target, 'baked');
    expect(writeGoogleCredential({ GOOGLE_APPLICATION_CREDENTIALS: target, GOOGLE_CREDENTIAL: SA }).status).toBe('present');
    expect(fs.readFileSync(target, 'utf8')).toBe('baked');
  });

  test('does nothing without a path or a credential', () => {
    expect(writeGoogleCredential({ GOOGLE_CREDENTIAL: SA }).status).toBe('unset');
    expect(writeGoogleCredential({ GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/x.json' }).status).toBe('no-source');
  });
});
