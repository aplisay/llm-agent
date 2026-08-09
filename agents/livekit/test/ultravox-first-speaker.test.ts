import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";
import {
  RealtimeModel,
  withFirstSpeakerOverride,
} from "../plugins/ultravox/src/realtime/realtime_model.js";

// Covers the one-shot `firstSpeakerSettings` override used by the consultative
// transfer consult leg, which shares the primary call's RealtimeModel but DIALS its
// peer (so the peer answers and greets first) instead of being dialled.
// run: npx tsx --test test/ultravox-first-speaker.test.ts

// The SDK's RealtimeSession base class resolves the logger at construction.
initializeLogger({ pretty: false, level: "fatal" });

const AGENT_FIRST = { agent: { text: "Hi, how can I help?", uninterruptible: true } };
const USER_FIRST = { user: { fallback: { delay: "3s", prompt: "say something" } } };

const baseOpts = (ultravox?: Record<string, unknown>) =>
  ({ instructions: "test agent", ...(ultravox ? { vendorSpecific: { ultravox } } : {}) }) as any;

const makeModel = (ultravox?: Record<string, unknown>) =>
  new RealtimeModel({
    instructions: "test agent",
    apiKey: "test-key",
    ...(ultravox ? { vendorSpecific: { ultravox } } : {}),
  } as any);

// --- merge semantics -------------------------------------------------------

test("no override: options pass through with firstSpeakerSettings intact", () => {
  const base = baseOpts({ firstSpeakerSettings: AGENT_FIRST });
  const opts = withFirstSpeakerOverride(base, undefined);
  assert.deepEqual(opts.vendorSpecific.ultravox.firstSpeakerSettings, AGENT_FIRST);
});

test("override REPLACES rather than merges an agent-first greeting", () => {
  const opts = withFirstSpeakerOverride(baseOpts({ firstSpeakerSettings: AGENT_FIRST }), USER_FIRST as any);
  const fs = opts.vendorSpecific!.ultravox!.firstSpeakerSettings as any;
  assert.deepEqual(fs, USER_FIRST);
  // Both `agent` and `user` populated is ambiguous to the Ultravox API.
  assert.equal(fs.agent, undefined, "agent-first greeting must not survive the override");
});

test("override applies when the model had no firstSpeakerSettings at all", () => {
  const opts = withFirstSpeakerOverride(baseOpts(), USER_FIRST as any);
  assert.deepEqual(opts.vendorSpecific!.ultravox!.firstSpeakerSettings, USER_FIRST);
});

test("override preserves sibling vendor options", () => {
  const base = baseOpts({
    firstSpeakerSettings: AGENT_FIRST,
    vadSettings: { turnEndpointDelay: "0.5s" },
    experimentalSettings: { transcriptionProvider: "whisper" },
  });
  const opts = withFirstSpeakerOverride(base, USER_FIRST as any);
  assert.deepEqual(opts.vendorSpecific!.ultravox!.vadSettings, { turnEndpointDelay: "0.5s" });
  assert.deepEqual(opts.vendorSpecific!.ultravox!.experimentalSettings, {
    transcriptionProvider: "whisper",
  });
});

test("override does not mutate the caller's options object", () => {
  const ultravox = { firstSpeakerSettings: AGENT_FIRST };
  const base = baseOpts(ultravox);
  withFirstSpeakerOverride(base, USER_FIRST as any);
  assert.deepEqual(
    ultravox.firstSpeakerSettings,
    AGENT_FIRST,
    "the model's shared defaults must be untouched",
  );
  assert.deepEqual(base.vendorSpecific.ultravox.firstSpeakerSettings, AGENT_FIRST);
});

// --- one-shot lifecycle ----------------------------------------------------

test("set then session(): the override is consumed exactly once", () => {
  const model = makeModel({ firstSpeakerSettings: AGENT_FIRST });
  model.setNextSessionFirstSpeaker(USER_FIRST as any);
  assert.deepEqual(model.pendingFirstSpeakerOverride, USER_FIRST);

  model.session();
  assert.equal(
    model.pendingFirstSpeakerOverride,
    undefined,
    "a later session — e.g. a primary-agent handover — must not inherit the consult posture",
  );
});

test("clearNextSessionFirstSpeaker discards a pending override", () => {
  const model = makeModel();
  model.setNextSessionFirstSpeaker(USER_FIRST as any);
  model.clearNextSessionFirstSpeaker();
  assert.equal(model.pendingFirstSpeakerOverride, undefined);
});

test("no override pending by default", () => {
  assert.equal(makeModel().pendingFirstSpeakerOverride, undefined);
});
