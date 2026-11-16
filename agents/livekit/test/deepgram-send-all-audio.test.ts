import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AudioEnergyFilter, initializeLogger } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

// The aux engine's way round the Deepgram plugin's 1 s silence drop (lib/deepgram-send-all-audio.ts).
// run: node --import tsx --test test/deepgram-send-all-audio.test.ts

initializeLogger({ pretty: false, level: "fatal" });
const { sendingAllAudio } = await import("../lib/deepgram-send-all-audio.js");

const silence = () => new AudioFrame(new Int16Array(160), 16000, 1, 160); // 10 ms
const speech = () => new AudioFrame(new Int16Array(160).fill(3000), 16000, 1, 160);

test("outside the scope the filter still drops silence 1 s after speech", () => {
  const filter = new AudioEnergyFilter();
  assert.equal(filter.pushFrame(speech()), true);
  let sent = 0;
  for (let i = 0; i < 150; i++) if (filter.pushFrame(silence())) sent++;
  assert.ok(sent < 101, `sent ${sent} of 150 silent frames`);
});

test("inside the scope, and in work it starts later, every frame is sent", async () => {
  const filter = sendingAllAudio(() => new AudioEnergyFilter());
  const results = await sendingAllAudio(
    () =>
      new Promise<boolean[]>((resolve) =>
        // The plugin's send loop starts with startSoon, after stream() returns.
        setImmediate(() => resolve(Array.from({ length: 150 }, () => filter.pushFrame(silence())))),
      ),
  );
  assert.ok(results.every(Boolean));
  // The same filter outside the scope drops silence again.
  assert.equal(Array.from({ length: 150 }, () => filter.pushFrame(silence())).every(Boolean), false);
});

test("the plugin is still 1.9.0: from 1.9.1 it sends all audio itself, so remove this module", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../node_modules/@livekit/agents-plugin-deepgram/package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.version, "1.9.0");
  const dist = readFileSync(new URL("../node_modules/@livekit/agents-plugin-deepgram/dist/stt.js", import.meta.url), "utf8");
  assert.match(dist, /new AudioEnergyFilter\(\)/);
});
