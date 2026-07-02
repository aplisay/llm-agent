import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBridgedTransferMap,
  DtmfSequenceMatcher,
  composeTakeoverPrompt,
} from "../lib/bridged-transfer-to-agent.js";

// Map parser + DTMF sequence matcher for options.bridgedTransferToAgent.
// run: node --import tsx --test test/bridged-transfer-to-agent.test.ts

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("parseBridgedTransferMap: absent/empty/invalid options give null", () => {
  assert.equal(parseBridgedTransferMap(undefined), null);
  assert.equal(parseBridgedTransferMap({}), null);
  assert.equal(parseBridgedTransferMap({ bridgedTransferToAgent: {} }), null);
  assert.equal(parseBridgedTransferMap({ bridgedTransferToAgent: "1" }), null);
  assert.equal(parseBridgedTransferMap({ bridgedTransferToAgent: ["1"] }), null);
});

test("parseBridgedTransferMap: normalises string and object values", () => {
  const map = parseBridgedTransferMap({
    bridgedTransferToAgent: {
      "1": "agent-a",
      "*7": { agent: "agent-b", includeHistory: false, fromLabel: "survey" },
      "22": { agent: "agent-c", includeHistory: "false" },
      "#3": { agent: "agent-d", includeHistory: true },
    },
  });
  assert.ok(map);
  assert.deepEqual(map!.get("1"), {
    key: "1",
    agentId: "agent-a",
    includeHistory: true, // defaults on
  });
  assert.deepEqual(map!.get("*7"), {
    key: "*7",
    agentId: "agent-b",
    includeHistory: false, // fromLabel annotation ignored
  });
  // Legacy "false" string idiom (cf. transfer_agent includeHistory)
  assert.equal(map!.get("22")!.includeHistory, false);
  assert.equal(map!.get("#3")!.includeHistory, true);
});

test("parseBridgedTransferMap: skips malformed entries, keeps good ones", () => {
  const map = parseBridgedTransferMap({
    bridgedTransferToAgent: {
      "1": "agent-a",
      ab: "agent-bad-key", // non-keypad chars
      "123456789": "agent-too-long", // > 8 chars
      "2": {}, // no agent id
      "3": { agent: 42 }, // non-string agent id
    },
  });
  assert.ok(map);
  assert.deepEqual([...map!.keys()], ["1"]);
});

test("matcher: unambiguous exact key fires immediately", async () => {
  const fired: string[] = [];
  const m = new DtmfSequenceMatcher(["1", "*7"], async (k) => {
    fired.push(k);
  }, 30);
  m.feed("1");
  await sleep(0);
  assert.deepEqual(fired, ["1"]);
  // Fires once: further digits are ignored after a successful match.
  m.feed("1");
  await sleep(50);
  assert.deepEqual(fired, ["1"]);
  m.cancel();
});

test("matcher: exact-but-extendable waits for the timeout", async () => {
  const fired: string[] = [];
  const m = new DtmfSequenceMatcher(["1", "12"], async (k) => {
    fired.push(k);
  }, 30);
  m.feed("1");
  await sleep(10);
  assert.deepEqual(fired, []); // still waiting for a possible "12"
  await sleep(50);
  assert.deepEqual(fired, ["1"]); // resolved to the exact key on timeout
  m.cancel();
});

test("matcher: longer key wins when completed before the timeout", async () => {
  const fired: string[] = [];
  const m = new DtmfSequenceMatcher(["1", "12"], async (k) => {
    fired.push(k);
  }, 30);
  m.feed("1");
  m.feed("2");
  await sleep(0);
  assert.deepEqual(fired, ["12"]);
  m.cancel();
});

test("matcher: bare prefix resets after the timeout", async () => {
  const fired: string[] = [];
  const m = new DtmfSequenceMatcher(["*7"], async (k) => {
    fired.push(k);
  }, 30);
  m.feed("*");
  await sleep(60);
  assert.deepEqual(fired, []); // prefix aged out, no match
  // A fresh full sequence still fires.
  m.feed("*");
  m.feed("7");
  await sleep(0);
  assert.deepEqual(fired, ["*7"]);
  m.cancel();
});

test("matcher: stray digits slide out oldest-first", async () => {
  const fired: string[] = [];
  const m = new DtmfSequenceMatcher(["*7"], async (k) => {
    fired.push(k);
  }, 30);
  m.feed("5"); // stray press — must not poison the following sequence
  m.feed("*");
  m.feed("7");
  await sleep(0);
  assert.deepEqual(fired, ["*7"]);
  m.cancel();
});

test("matcher: re-arms when the takeover handler throws", async () => {
  let attempts = 0;
  const m = new DtmfSequenceMatcher(["1"], async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("target agent busy");
  }, 30);
  m.feed("1");
  await sleep(0);
  assert.equal(attempts, 1);
  // First attempt failed (bridge still up) — a retry press works.
  m.feed("1");
  await sleep(0);
  assert.equal(attempts, 2);
  // Second attempt succeeded — matcher stays fired.
  m.feed("1");
  await sleep(50);
  assert.equal(attempts, 2);
  m.cancel();
});

test("composeTakeoverPrompt: history carried by default, dropped when off", () => {
  const agent = { id: "a1", prompt: "You are the booking agent." } as any;
  const withHistory = composeTakeoverPrompt(agent, "Caller: hi\nAgent: hello", true);
  assert.match(withHistory, /^You are the booking agent\./);
  assert.match(withHistory, /taken over a live call/);
  assert.match(withHistory, /# Conversation between the caller and the previous agent/);
  assert.match(withHistory, /Caller: hi/);
  assert.match(withHistory, /was not recorded/);

  const fresh = composeTakeoverPrompt(agent, "Caller: hi", false);
  assert.match(fresh, /Treat this as a fresh conversation/);
  assert.doesNotMatch(fresh, /# Conversation/);
});

test("composeTakeoverPrompt: bridged-segment transcript carried when present", () => {
  const agent = { id: "a1", prompt: "You are the booking agent." } as any;
  const bridge = "> caller: can I book tuesday\n> transfer target: sure\n";
  const prompt = composeTakeoverPrompt(
    agent,
    "Caller: hi\nAgent: hello",
    true,
    bridge,
  );
  assert.match(prompt, /# Conversation between the caller and the previous agent/);
  assert.match(prompt, /Caller: hi/);
  assert.match(
    prompt,
    /# Conversation between the caller and the human transfer target/,
  );
  assert.match(prompt, /> caller: can I book tuesday/);
  // With a bridge transcript, the "not recorded" note is replaced by it.
  assert.doesNotMatch(prompt, /was not recorded/);
  // Bridge section comes after the pre-transfer history section (pipecat order).
  assert.ok(
    prompt.indexOf("# Conversation between the caller and the previous agent") <
      prompt.indexOf(
        "# Conversation between the caller and the human transfer target",
      ),
  );
});

test("composeTakeoverPrompt: bridge transcript without pre-transfer history", () => {
  const agent = { id: "a1", prompt: "You are the booking agent." } as any;
  const prompt = composeTakeoverPrompt(agent, "", true, "> caller: hello\n");
  assert.doesNotMatch(
    prompt,
    /# Conversation between the caller and the previous agent/,
  );
  assert.match(
    prompt,
    /# Conversation between the caller and the human transfer target/,
  );
  // No history at all → no "not recorded" note either.
  assert.doesNotMatch(prompt, /was not recorded/);
});

test("composeTakeoverPrompt: includeHistory false suppresses the bridge transcript too", () => {
  const agent = { id: "a1", prompt: "You are the booking agent." } as any;
  const prompt = composeTakeoverPrompt(
    agent,
    "Caller: hi",
    false,
    "> caller: secret\n",
  );
  assert.match(prompt, /Treat this as a fresh conversation/);
  assert.doesNotMatch(prompt, /# Conversation/);
  assert.doesNotMatch(prompt, /secret/);
});
