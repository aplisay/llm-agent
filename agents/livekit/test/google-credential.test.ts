import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeGoogleCredential } from "../lib/google-credential.js";

// Run: npx tsx --test test/google-credential.test.ts

const SA = '{"type":"service_account","project_id":"test"}';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gcred-"));
}

test("writes GOOGLE_CREDENTIAL to the GOOGLE_APPLICATION_CREDENTIALS path, mode 0600", () => {
  const target = path.join(tempDir(), "credentials", "google.json");
  const result = writeGoogleCredential({
    GOOGLE_APPLICATION_CREDENTIALS: target,
    GOOGLE_CREDENTIAL: SA,
  });
  assert.deepEqual(result, { status: "written", path: target, bytes: SA.length });
  assert.equal(fs.readFileSync(target, "utf8"), SA);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("resolves a relative path against the working directory, as the bundle sets it", () => {
  const dir = tempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const result = writeGoogleCredential({
      GOOGLE_APPLICATION_CREDENTIALS: "credentials/google.json",
      GOOGLE_CREDENTIAL: SA,
    });
    assert.equal(result.status, "written");
    assert.equal(fs.readFileSync(path.join(dir, "credentials/google.json"), "utf8"), SA);
  } finally {
    process.chdir(cwd);
  }
});

test("takes the inline GOOGLE_APPLICATION_CREDENTIALS_JSON form too", () => {
  const target = path.join(tempDir(), "google.json");
  const result = writeGoogleCredential({
    GOOGLE_APPLICATION_CREDENTIALS: target,
    GOOGLE_APPLICATION_CREDENTIALS_JSON: SA,
  });
  assert.equal(result.status, "written");
  assert.equal(fs.readFileSync(target, "utf8"), SA);
});

test("leaves an existing file alone", () => {
  const target = path.join(tempDir(), "google.json");
  fs.writeFileSync(target, "mounted");
  const result = writeGoogleCredential({
    GOOGLE_APPLICATION_CREDENTIALS: target,
    GOOGLE_CREDENTIAL: SA,
  });
  assert.deepEqual(result, { status: "present", path: target });
  assert.equal(fs.readFileSync(target, "utf8"), "mounted");
});

test("a second call (a job process after the supervisor) is a no-op", () => {
  const target = path.join(tempDir(), "google.json");
  const env = { GOOGLE_APPLICATION_CREDENTIALS: target, GOOGLE_CREDENTIAL: SA };
  assert.equal(writeGoogleCredential(env).status, "written");
  assert.equal(writeGoogleCredential(env).status, "present");
});

test("does nothing when the path is unset", () => {
  assert.deepEqual(writeGoogleCredential({ GOOGLE_CREDENTIAL: SA }), { status: "unset" });
});

test("reports a missing source without writing", () => {
  const target = path.join(tempDir(), "google.json");
  const result = writeGoogleCredential({ GOOGLE_APPLICATION_CREDENTIALS: target });
  assert.deepEqual(result, { status: "no-source", path: target });
  assert.equal(fs.existsSync(target), false);
});

test("reports a write failure instead of throwing", () => {
  const blocker = path.join(tempDir(), "not-a-dir");
  fs.writeFileSync(blocker, "");
  const target = path.join(blocker, "google.json");
  const result = writeGoogleCredential({
    GOOGLE_APPLICATION_CREDENTIALS: target,
    GOOGLE_CREDENTIAL: SA,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.path, target);
});
