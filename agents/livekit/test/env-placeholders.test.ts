import { test } from "node:test";
import assert from "node:assert/strict";
import { clearPlaceholders } from "../lib/env-placeholders.js";

// Run: npx tsx --test test/env-placeholders.test.ts

test("deletes values written as <...> and keeps the rest", () => {
  const env: NodeJS.ProcessEnv = {
    LIVEKIT_API_KEY: "<LIVEKIT API KEY>",
    JAMBONZ_SERVER: "<JAMBONZ API SERVER HOSTNAME>, usually api.server.name",
    LIVEKIT_URL: "wss://example.livekit.cloud",
    EMPTY: "",
    ANGLE_INSIDE: "a<b>",
  };
  assert.deepEqual(clearPlaceholders(env).sort(), ["JAMBONZ_SERVER", "LIVEKIT_API_KEY"]);
  assert.deepEqual(env, { LIVEKIT_URL: "wss://example.livekit.cloud", EMPTY: "", ANGLE_INSIDE: "a<b>" });
});
