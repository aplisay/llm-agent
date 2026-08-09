import { test } from "node:test";
import assert from "node:assert/strict";
import {
  promptWithMetadata,
  resolvePromptMetadataLines,
  PROMPT_METADATA_HEADING,
} from "../agent-lib/prompt-metadata.js";

// `promptMetadata` — call metadata stated in the system prompt instead of
// fetched with a get_metadata tool call (docs/prompt-metadata.md). The LiveKit
// worker consumes the SHARED lib/prompt-metadata.js via an agent-lib symlink
// (no TS twin to drift), and resolves it in createVoiceModelAndSession so the
// initial session and every transfer_agent handover both get it.
// run: node --import tsx --test test/prompt-metadata.test.ts

const METADATA = {
  aplisay: { callerId: "+447700900123", calledId: "+441234567890" },
  crm: { tier: "gold" },
};

test("renders '<description> <value>' per entry, in declaration order", () => {
  const lines = resolvePromptMetadataLines(
    [
      { description: "The number this caller is calling from is", from: "aplisay.callerId" },
      { description: "They dialled", from: "aplisay.calledId" },
    ],
    METADATA,
  );
  assert.deepEqual(lines, [
    "The number this caller is calling from is +447700900123",
    "They dialled +441234567890",
  ]);
});

test("aplisay.dateTime is computed live, and a seeded value wins", () => {
  const [live] = resolvePromptMetadataLines([{ from: "aplisay.dateTime" }], METADATA);
  assert.match(live!, /^\w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
  assert.deepEqual(
    resolvePromptMetadataLines([{ from: "aplisay.dateTime" }], { aplisay: { dateTime: "SEEDED" } }),
    ["SEEDED"],
  );
});

test("absent values are omitted, never stated as 'undefined'", () => {
  const lines = resolvePromptMetadataLines(
    [
      { description: "Account tier is", from: "crm.tier" },
      { description: "Loyalty number is", from: "crm.loyaltyNumber" },
    ],
    METADATA,
  );
  assert.deepEqual(lines, ["Account tier is gold"]);
  assert.doesNotMatch(lines.join("\n"), /undefined/);
});

test("the block is appended after the agent's own prompt", () => {
  const out = promptWithMetadata(
    "You are a booking agent.",
    [{ description: "Today is", from: "aplisay.dateTime" }],
    METADATA,
  );
  assert.ok(out.startsWith("You are a booking agent."));
  assert.ok(out.includes(PROMPT_METADATA_HEADING));
  assert.match(out.split("\n").pop()!, /^Today is /);
});

test("the prompt is returned untouched when nothing resolves", () => {
  const prompt = "You are a helpful assistant.";
  assert.equal(promptWithMetadata(prompt, undefined, METADATA), prompt);
  assert.equal(promptWithMetadata(prompt, [], METADATA), prompt);
  assert.equal(promptWithMetadata(prompt, [{ from: "not.present" }], METADATA), prompt);
});
