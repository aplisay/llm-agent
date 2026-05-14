/**
 * Minimal regression checks for voice-mode + pipeline inference (run after `yarn build`).
 */
import assert from "node:assert/strict";
import { resolvePipelineStt } from "../dist/lib/pipeline-inference-options.js";
import { resolveVoiceMode } from "../dist/lib/voice-mode.js";

assert.equal(
  resolveVoiceMode("livekit:openai/gpt-realtime", {}),
  "realtime",
  "realtime catalog model",
);
assert.equal(
  resolveVoiceMode("livekit:openai/gpt-4o-mini", {}),
  "pipeline",
  "pipeline catalog model without voiceMode",
);
assert.equal(
  resolveVoiceMode("livekit:openai/gpt-4o", { voiceMode: "pipeline" }),
  "pipeline",
);
assert.equal(
  resolveVoiceMode("livekit:openai/gpt-4o", { voiceMode: "realtime" }),
  "realtime",
);

assert.match(
  resolvePipelineStt({ options: { stt: { language: "any" } } }),
  /^deepgram\/nova-3:en$/,
  "stt language any must not be forwarded to Inference (Deepgram rejects it)",
);
assert.match(
  resolvePipelineStt({ options: { stt: { language: "en-GB" } } }),
  /^deepgram\/nova-3:en$/,
);
assert.match(
  resolvePipelineStt({ options: { stt: { language: "fr" } } }),
  /^deepgram\/nova-3:fr$/,
);

console.log("voice-selftest: ok");
