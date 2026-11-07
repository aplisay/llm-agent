import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordingWhenStorable } from "../lib/call-recording.js";

// Run: npx tsx --test test/recording-storage-gate.test.ts

const STORAGE_VARS = ["RECORDING_STORAGE_PATH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CREDENTIAL", "K_SERVICE"];

function withEnv(env: Record<string, string>, fn: () => void) {
  const saved = Object.fromEntries(STORAGE_VARS.map((name) => [name, process.env[name]]));
  const cwd = process.cwd();
  for (const name of STORAGE_VARS) delete process.env[name];
  Object.assign(process.env, env);
  // A directory with no credentials/google.json in it.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "rec-gate-")));
  try {
    fn();
  } finally {
    process.chdir(cwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a requested recording is turned off when no storage is configured", () => {
  withEnv({}, () => {
    assert.deepEqual(recordingWhenStorable({ enabled: true, key: "k" }), { enabled: false, key: "k" });
  });
});

test("a requested recording is kept when storage is configured", () => {
  const options = { enabled: true };
  withEnv({ RECORDING_STORAGE_PATH: "file:///tmp/recordings" }, () => {
    assert.equal(recordingWhenStorable(options), options);
  });
  withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "credentials/google.json" }, () => {
    assert.equal(recordingWhenStorable(options), options);
  });
});

test("no recording request passes through", () => {
  withEnv({}, () => {
    assert.equal(recordingWhenStorable(undefined), undefined);
    assert.deepEqual(recordingWhenStorable({ enabled: false }), { enabled: false });
  });
});
