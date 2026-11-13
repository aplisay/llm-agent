import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BackgroundGate,
  FADE_IN_MS,
  FADE_OUT_MS,
  LoopReader,
  WORKING_MAX_MS,
  backgroundConfigFromOptions,
  createBackgroundAudio,
  scaledAsset,
  type BackgroundAudioConfig,
} from "../lib/background-audio.js";

// options.backgroundAudio: the parser, the gate, the loop and fades, and the
// lazy control the worker holds. See docs/background-audio.md.
// run: npx tsx --test test/background-audio.test.ts

const RATE = 16_000;

const config = (over: Partial<BackgroundAudioConfig> = {}): BackgroundAudioConfig => ({
  sound: "office",
  volume: 0.1,
  when: "thinking",
  delayMs: 600,
  ...over,
});

/** A gate past start-up, as it is once the session has said "listening". */
const liveGate = (over: Partial<BackgroundAudioConfig> = {}, mode: "pipeline" | "realtime" = "pipeline") => {
  const gate = new BackgroundGate(config(over), mode);
  gate.noteAgentState("listening");
  return gate;
};

test("parser: off unless the option is set and enabled", () => {
  assert.equal(backgroundConfigFromOptions(undefined), null);
  assert.equal(backgroundConfigFromOptions({}), null);
  assert.equal(backgroundConfigFromOptions({ backgroundAudio: false }), null);
  assert.equal(backgroundConfigFromOptions({ backgroundAudio: { enabled: false } }), null);
  assert.equal(backgroundConfigFromOptions({ backgroundAudio: "office" }), null);
  assert.equal(backgroundConfigFromOptions({ backgroundAudio: ["office"] }), null);
});

test("parser: true and an empty object give the defaults", () => {
  const defaults = { sound: "office", volume: 0.1, when: "thinking", delayMs: 600 };
  assert.deepEqual(backgroundConfigFromOptions({ backgroundAudio: true }), defaults);
  assert.deepEqual(backgroundConfigFromOptions({ backgroundAudio: {} }), defaults);
});

test("parser: levels, modes and clamps", () => {
  const parse = (raw: unknown) => backgroundConfigFromOptions({ backgroundAudio: raw })!;
  assert.equal(parse({ volume: "low" }).volume, 0.05);
  assert.equal(parse({ volume: "HIGH" }).volume, 0.2);
  assert.equal(parse({ volume: "loud" }).volume, 0.1);
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(parse({ volume: key }).volume, 0.1, key);
  }
  assert.equal(parse({ when: "silent" }).when, "silent");
  assert.equal(parse({ when: "Always" }).when, "always");
  assert.equal(parse({ when: "never" }).when, "thinking");
  assert.equal(parse({ delayMs: -5 }).delayMs, 0);
  assert.equal(parse({ delayMs: 99_999 }).delayMs, 10_000);
  assert.equal(parse({ delayMs: 250.4 }).delayMs, 250);
  assert.equal(parse({ delayMs: "300" }).delayMs, 600);
  assert.equal(parse({ sound: "cafe" }).sound, "office");
});

test("gate: shut while the session is starting, except in always mode", () => {
  for (const when of ["thinking", "silent"] as const) {
    const gate = new BackgroundGate(config({ when, delayMs: 0 }));
    gate.toolStarted();
    assert.equal(gate.evaluate(0).open, false, when);
  }
  assert.equal(new BackgroundGate(config({ when: "always" })).evaluate(0).open, true);
});

test("gate: thinking opens after delayMs of agent work in silence", () => {
  const gate = liveGate();
  gate.noteAgentState("thinking");
  assert.deepEqual(gate.evaluate(1_000), { open: false, waitMs: 600 });
  assert.deepEqual(gate.evaluate(1_400), { open: false, waitMs: 200 });
  assert.deepEqual(gate.evaluate(1_600), { open: true, waitMs: 0 });
  // The agent speaks: shut at once, and the hold starts again afterwards.
  gate.noteAgentState("speaking");
  assert.equal(gate.evaluate(1_700).open, false);
  gate.noteAgentState("thinking");
  assert.equal(gate.evaluate(1_800).open, false);
  assert.equal(gate.evaluate(2_400).open, true);
});

test("gate: thinking stays shut while the caller speaks or nothing is pending", () => {
  const gate = liveGate();
  assert.equal(gate.evaluate(0).open, false);
  assert.equal(gate.evaluate(60_000).open, false);
  gate.noteAgentState("thinking");
  gate.noteUserState("speaking", 0);
  assert.equal(gate.evaluate(10_000).open, false);
});

test("gate: a running tool counts as work, and a new session forgets it", () => {
  const gate = liveGate({ delayMs: 0 });
  const id = gate.toolStarted();
  assert.equal(gate.evaluate(0).open, true);
  gate.toolFinished(id);
  assert.equal(gate.evaluate(1).open, false);

  const stale = gate.toolStarted();
  gate.startSession("pipeline", "listening");
  assert.equal(gate.evaluate(2).open, false);
  const fresh = gate.toolStarted();
  gate.toolFinished(stale);
  assert.equal(gate.evaluate(3).open, true, "a stale id must not end the new session's call");
  gate.toolFinished(fresh);
  assert.equal(gate.evaluate(4).open, false);
});

test("gate: realtime counts the gap between the caller's turn and the reply", () => {
  const gate = liveGate({}, "realtime");
  gate.noteUserState("speaking", 0);
  gate.noteUserState("listening", 1_000);
  assert.equal(gate.evaluate(1_000).open, false);
  assert.equal(gate.evaluate(1_600).open, true);
  gate.noteAgentState("speaking");
  assert.equal(gate.evaluate(2_000).open, false);
  gate.noteAgentState("listening");
  assert.equal(gate.evaluate(5_000).open, false, "the reply ended the wait");
});

test("gate: the realtime turn signal gives up after the backstop", () => {
  const gate = liveGate({ delayMs: 0 }, "realtime");
  gate.noteUserState("speaking", 0);
  gate.noteUserState("listening", 0);
  assert.equal(gate.evaluate(WORKING_MAX_MS - 1).open, true);
  assert.equal(gate.evaluate(WORKING_MAX_MS).open, false);
});

test("gate: pipeline models rely on the SDK's thinking state, not the turn signal", () => {
  const gate = liveGate({ delayMs: 0 }, "pipeline");
  gate.noteUserState("speaking", 0);
  gate.noteUserState("listening", 0);
  assert.equal(gate.evaluate(1_000).open, false);
});

test("gate: silent opens whenever the agent is quiet, caller speech included", () => {
  const gate = liveGate({ when: "silent", delayMs: 300 });
  assert.equal(gate.evaluate(0).open, false);
  assert.equal(gate.evaluate(300).open, true);
  gate.noteUserState("speaking", 400);
  assert.equal(gate.evaluate(400).open, true);
  gate.noteAgentState("speaking");
  assert.equal(gate.evaluate(500).open, false);
});

test("gate: always ignores delayMs and speech", () => {
  const gate = liveGate({ when: "always", delayMs: 10_000 });
  gate.noteAgentState("speaking");
  gate.noteUserState("speaking", 0);
  assert.deepEqual(gate.evaluate(0), { open: true, waitMs: 0 });
});

test("gate: every mode is shut by a transfer, a bridge, the handover tone or the end", () => {
  for (const when of ["thinking", "silent", "always"] as const) {
    const blocks: Array<[string, (g: BackgroundGate) => void, (g: BackgroundGate) => void]> = [
      ["dialling", (g) => g.setTransferState("dialling"), (g) => g.setTransferState("failed")],
      ["talking", (g) => g.setTransferState("talking"), (g) => g.setTransferState("rejected")],
      ["bridged", (g) => g.setBridged(true), (g) => g.setBridged(false)],
      ["handover tone", (g) => g.setHandoverTone(true), (g) => g.setHandoverTone(false)],
    ];
    for (const [name, block, unblock] of blocks) {
      const gate = liveGate({ when, delayMs: 0 });
      gate.noteAgentState("thinking");
      assert.equal(gate.evaluate(0).open, true, `${when} open before ${name}`);
      block(gate);
      assert.equal(gate.evaluate(1).open, false, `${when} shut by ${name}`);
      unblock(gate);
      assert.equal(gate.evaluate(2).open, true, `${when} open after ${name}`);
    }
    const gate = liveGate({ when, delayMs: 0 });
    gate.noteAgentState("thinking");
    gate.setEnding();
    assert.equal(gate.evaluate(0).open, false, `${when} shut when ending`);
  }
});

test("gate: a completed bridge blocks even though the transfer state is none", () => {
  const gate = liveGate({ when: "silent", delayMs: 0 });
  gate.setTransferState("dialling");
  gate.setBridged(true);
  gate.setTransferState("none");
  assert.equal(gate.evaluate(0).open, false);
});

test("gate: a handover to another agent's settings restarts the hold", () => {
  const gate = liveGate({ when: "silent", delayMs: 100 });
  assert.equal(gate.evaluate(0).open, false);
  assert.equal(gate.evaluate(100).open, true);
  gate.reconfigure(config({ when: "silent", delayMs: 500 }));
  assert.equal(gate.evaluate(150).open, false);
  assert.equal(gate.evaluate(650).open, true);
});

test("loop: wraps at the end of the clip and carries on where it stopped", () => {
  const samples = Int16Array.from([1, 2, 3, 4, 5]);
  const reader = new LoopReader(samples, 3);
  // Jump straight to full level to test the copy path on its own.
  reader.setOpen(true);
  const warm = new Int16Array(RATE);
  reader.fill(warm);
  const out = new Int16Array(7);
  const start = reader.pos;
  reader.fill(out);
  const expected = Array.from({ length: 7 }, (_, i) => samples[(start + i) % 5]);
  assert.deepEqual(Array.from(out), expected);
  assert.equal(reader.pos, (start + 7) % 5);
});

test("fades: 300 ms in, 120 ms out, linear, then a plain copy", () => {
  const samples = new Int16Array(RATE).fill(10_000);
  const reader = new LoopReader(samples, 0);
  assert.equal(reader.silent, true);
  reader.setOpen(true);

  const inSamples = (RATE * FADE_IN_MS) / 1000;
  const half = new Int16Array(inSamples / 2);
  reader.fill(half);
  assert.ok(Math.abs(reader.level - 0.5) < 1e-3, `half way in: ${reader.level}`);
  assert.ok(half[0] > 0 && half[0] < 10, "starts from silence");
  assert.ok(half[half.length - 1] > half[0], "rises");

  reader.fill(new Int16Array(inSamples / 2));
  assert.equal(reader.level, 1);
  const full = new Int16Array(800);
  reader.fill(full);
  assert.ok(full.every((v) => v === 10_000), "full level copies the scaled buffer");

  reader.setOpen(false);
  const outSamples = (RATE * FADE_OUT_MS) / 1000;
  const fadeOut = new Int16Array(outSamples);
  reader.fill(fadeOut);
  assert.equal(reader.level, 0);
  assert.equal(fadeOut[fadeOut.length - 1], 0);
  assert.equal(reader.silent, true);
});

test("fades: closing half way through a fade in turns round from that level", () => {
  const reader = new LoopReader(new Int16Array(RATE).fill(1_000), 0);
  reader.setOpen(true);
  reader.fill(new Int16Array((RATE * FADE_IN_MS) / 1000 / 2));
  reader.setOpen(false);
  const out = new Int16Array(10);
  reader.fill(out);
  assert.ok(out[0] < 500 && out[0] > 480, `continues from about half: ${out[0]}`);
  assert.ok(out[9] < out[0], "falls");
});

test("asset: loads, is 16 kHz mono and is scaled once per volume", () => {
  const medium = scaledAsset(config({ volume: 0.1 }));
  const high = scaledAsset(config({ volume: 0.2 }));
  assert.equal(medium, scaledAsset(config({ volume: 0.1 })), "cached per volume");
  assert.ok(medium.length > RATE * 10, `length ${medium.length}`);
  let peak = 0;
  for (const v of high) peak = Math.max(peak, Math.abs(v));
  // The asset peaks near -2 dBFS, so 0.2 keeps it well below a quarter of full scale.
  assert.ok(peak > 1_000 && peak < 8_192, `peak ${peak}`);
});

test("control: builds nothing and touches no room when the option is off", () => {
  let roomAsked = 0;
  const control = createBackgroundAudio({}, {
    getRoom: () => {
      roomAsked += 1;
      return null;
    },
    isBridged: () => false,
  });
  control.start();
  control.setTransferState("dialling");
  control.setHandoverTone(true);
  control.noteEnding();
  const settled = control.toolStarted();
  settled();
  assert.equal(roomAsked, 0);
});

test("control: a handover to an agent with the option builds the player then", () => {
  let roomAsked = 0;
  const control = createBackgroundAudio({}, {
    getRoom: () => {
      roomAsked += 1;
      // Not connected: the player logs and publishes nothing.
      return { isConnected: false } as any;
    },
    isBridged: () => false,
  });
  control.start();
  assert.equal(roomAsked, 0);
  control.configure({ backgroundAudio: { when: "silent" } });
  assert.equal(roomAsked, 1, "the room was started before, so the new player publishes");
  control.close();
});
