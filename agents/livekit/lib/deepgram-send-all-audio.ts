/**
 * Deepgram plugin 1.9.0 drops audio 1 s after speech (AudioEnergyFilter), so Deepgram never
 * hears a longer pause and its endpointing cannot work above that. Plugin 1.9.1 sends all audio
 * (agents-js PR #2586). Until the worker moves to 1.9.1 or later, a stream created inside
 * sendingAllAudio() gets the same; every other stream keeps the filter. Remove on upgrade:
 * test/deepgram-send-all-audio.test.ts fails once the plugin is no longer 1.9.0.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AudioEnergyFilter } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";

const sendAll = new AsyncLocalStorage<boolean>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const original = AudioEnergyFilter.prototype.pushFrame;
  // The plugin's send loop starts from inside stream() (startSoon), so it runs in the scope set there.
  AudioEnergyFilter.prototype.pushFrame = function pushFrame(this: AudioEnergyFilter, frame: AudioFrame): boolean {
    return sendAll.getStore() === true || original.call(this, frame);
  };
}

/** Run `create` (an `stt.stream()` call) so the stream it creates sends Deepgram all audio. */
export function sendingAllAudio<T>(create: () => T): T {
  install();
  return sendAll.run(true, create);
}
