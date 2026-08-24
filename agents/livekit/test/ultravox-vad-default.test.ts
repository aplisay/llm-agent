import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRealtimeLlmOptions,
  ULTRAVOX_DEFAULT_VAD_SETTINGS,
} from "../lib/voice-session-factory.js";

// Covers the platform default for Ultravox vadSettings. Ultravox's stock
// minimumInterruptionDuration is 0.09s, which lets any ~90ms sound (a breath,
// a backchannel "mm-hm") cancel agent speech mid-turn; the cancelled turn is
// finalised truncated and nothing re-offers the lost answer. What is pinned:
// every Ultravox session carries the 0.48s default unless the agent supplies
// an explicit vendorSpecific.ultravox.vadSettings, an explicit value replaces
// the default WHOLESALE (documented contract — never merged), the default
// composes with the greeting/inactivity vendorSpecific mappings, and
// non-Ultravox models are untouched.
// run: npx tsx --test test/ultravox-vad-default.test.ts

const ULTRAVOX = "livekit:ultravox/ultravox-v0.7";
const OPENAI = "livekit:openai/gpt-4o-realtime";

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ prompt: "You are a test agent.", options }) as any;

const uv = (modelName: string, agent: any) =>
  (buildRealtimeLlmOptions(modelName, agent, "call-1").vendorSpecific as any)?.ultravox;

test("ultravox sessions get the default vadSettings out of the box", () => {
  assert.deepEqual(uv(ULTRAVOX, makeAgent()).vadSettings, {
    minimumInterruptionDuration: "0.48s",
  });
  assert.equal(
    ULTRAVOX_DEFAULT_VAD_SETTINGS.minimumInterruptionDuration,
    "0.48s",
  );
});

test("an explicit vendorSpecific vadSettings replaces the default wholesale", () => {
  const agent = makeAgent({
    vendorSpecific: { ultravox: { vadSettings: { turnEndpointDelay: "0.5s" } } },
  });
  const settings = uv(ULTRAVOX, agent).vadSettings;
  assert.deepEqual(settings, { turnEndpointDelay: "0.5s" });
  assert.equal(settings.minimumInterruptionDuration, undefined);
});

test("the default preserves other vendorSpecific keys", () => {
  const agent = makeAgent({
    vendorSpecific: {
      google: { geminiVoiceName: "Kore" },
      ultravox: { experimentalSettings: { transcriptionProvider: "deepgram-nova-3" } },
    },
  });
  const opts = buildRealtimeLlmOptions(ULTRAVOX, agent, "call-1");
  const vendor = opts.vendorSpecific as any;
  assert.deepEqual(vendor.ultravox.vadSettings, ULTRAVOX_DEFAULT_VAD_SETTINGS);
  assert.deepEqual(vendor.ultravox.experimentalSettings, {
    transcriptionProvider: "deepgram-nova-3",
  });
  assert.deepEqual(vendor.google, { geminiVoiceName: "Kore" });
});

test("the default composes with the greeting and inactivity mappings", () => {
  const agent = makeAgent({
    greeting: { text: "Hello there" },
    inactivity: { timeout: "6s", message: "Are you still there?" },
  });
  const ultravox = uv(ULTRAVOX, agent);
  assert.deepEqual(ultravox.vadSettings, ULTRAVOX_DEFAULT_VAD_SETTINGS);
  assert.equal(ultravox.firstSpeakerSettings.agent.text, "Hello there");
  assert.equal(ultravox.inactivityMessages.length, 3);
});

test("the default object is copied per session, so callers cannot mutate the constant", () => {
  const settings = uv(ULTRAVOX, makeAgent()).vadSettings;
  settings.minimumInterruptionDuration = "9s";
  assert.equal(
    uv(ULTRAVOX, makeAgent()).vadSettings.minimumInterruptionDuration,
    "0.48s",
  );
});

test("non-ultravox realtime models are untouched", () => {
  assert.equal(buildRealtimeLlmOptions(OPENAI, makeAgent(), "call-1").vendorSpecific, undefined);
  const agent = makeAgent({ vendorSpecific: { openai: { foo: 1 } } });
  assert.deepEqual(buildRealtimeLlmOptions(OPENAI, agent, "call-1").vendorSpecific, {
    openai: { foo: 1 },
  });
});
