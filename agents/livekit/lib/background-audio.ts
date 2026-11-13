/**
 * Background sound for `options.backgroundAudio`. See docs/background-audio.md.
 * Mirrors agents/pipecat/pipecat_aplisay/background_audio.py: keep the option
 * shape, the levels and the gate rules in step with it and with
 * lib/background-audio-options.js.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  RoomEvent,
  type Room,
} from "@livekit/rtc-node";
import { voice } from "@livekit/agents";
import logger from "./logger.js";
import { decodeWav } from "../agent-lib/fallback-message/index.js";
import type { TransferState } from "./transfer-handler.js";
import type { VoiceMode } from "./voice-mode.js";

export type BackgroundWhen = "thinking" | "silent" | "always";

/** Resolved settings. Not the public interface: see backgroundConfigFromOptions. */
export interface BackgroundAudioConfig {
  sound: "office";
  /** Linear gain on the asset. */
  volume: number;
  when: BackgroundWhen;
  delayMs: number;
}

// Gains against the asset's -20 dBFS mean level: -46, -40 and -34 dBFS.
// A Map, so a key such as "constructor" finds nothing rather than a prototype member.
const VOLUME_LEVEL = new Map<string, number>([
  ["low", 0.05],
  ["medium", 0.1],
  ["high", 0.2],
]);
const WHEN: BackgroundWhen[] = ["thinking", "silent", "always"];

const DEFAULTS: BackgroundAudioConfig = {
  sound: "office",
  volume: 0.1,
  when: "thinking",
  delayMs: 600,
};

const MAX_DELAY_MS = 10_000;
const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = (SAMPLE_RATE * 50) / 1000;
// captureFrame blocks once this is full, which paces the loop with no timer.
const QUEUE_MS = 100;
export const FADE_IN_MS = 300;
export const FADE_OUT_MS = 120;
// Backstop for the realtime "turn ended, no reply yet" signal: a turn the model
// ignores would otherwise count as work for the rest of the call.
export const WORKING_MAX_MS = 20_000;

/**
 * Parse `options.backgroundAudio`: `true`, or an object with `sound`, `volume`,
 * `when` and `delayMs`. Returns null when the option is off. Bad values fall
 * back to the defaults or are clamped: save-time validation is the real check.
 */
export function backgroundConfigFromOptions(options: any): BackgroundAudioConfig | null {
  const raw = options?.backgroundAudio;
  if (raw === true) return { ...DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.enabled === false) {
    return null;
  }
  const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
  const when = WHEN.find((w) => w === lower(raw.when)) ?? DEFAULTS.when;
  const volume = VOLUME_LEVEL.get(lower(raw.volume)) ?? DEFAULTS.volume;
  const delayMs =
    typeof raw.delayMs === "number" && Number.isFinite(raw.delayMs)
      ? Math.round(Math.min(MAX_DELAY_MS, Math.max(0, raw.delayMs)))
      : DEFAULTS.delayMs;
  return { sound: "office", volume, when, delayMs };
}

export interface GateDecision {
  open: boolean;
  /** While shut: ms until `delayMs` has been held, or null if nothing is pending. */
  waitMs: number | null;
}

/** The open/shut decision, with no I/O and the clock passed in. */
export class BackgroundGate {
  private agentAudible = false;
  private userSpeaking = false;
  private thinking = false;
  private tools = new Set<number>();
  private nextToolId = 1;
  private turnEndedAt: number | null = null;
  private transferState: TransferState = "none";
  private bridged = false;
  private handoverTone = false;
  private ending = false;
  private initializing = true;
  private satisfiedSince: number | null = null;

  constructor(
    private config: BackgroundAudioConfig,
    private mode: VoiceMode = "pipeline",
  ) {}

  reconfigure(config: BackgroundAudioConfig): void {
    this.config = config;
    this.satisfiedSince = null;
  }

  /** A new session: forget the old one's speech and tool state. */
  startSession(mode: VoiceMode, agentState?: string): void {
    this.mode = mode;
    this.agentAudible = false;
    this.userSpeaking = false;
    this.thinking = false;
    this.tools.clear();
    this.turnEndedAt = null;
    this.initializing = true;
    this.satisfiedSince = null;
    if (agentState) this.noteAgentState(agentState);
  }

  noteAgentState(state: string | undefined): void {
    if (!state) return;
    if (state !== "initializing") this.initializing = false;
    this.agentAudible = state === "speaking";
    this.thinking = state === "thinking";
    if (state === "speaking") this.turnEndedAt = null;
  }

  noteUserState(state: string | undefined, now = Date.now()): void {
    if (!state) return;
    const speaking = state === "speaking";
    if (this.userSpeaking && !speaking) this.turnEndedAt = now;
    this.userSpeaking = speaking;
  }

  /** Returns an id for toolFinished. Ids from a previous session are ignored. */
  toolStarted(): number {
    const id = this.nextToolId++;
    this.tools.add(id);
    return id;
  }

  toolFinished(id: number): void {
    this.tools.delete(id);
  }

  setTransferState(state: TransferState): void {
    this.transferState = state;
  }

  setBridged(bridged: boolean): void {
    this.bridged = bridged;
  }

  setHandoverTone(active: boolean): void {
    this.handoverTone = active;
  }

  setEnding(): void {
    this.ending = true;
  }

  // A completed bridge sets the transfer state back to "none", so the bridge
  // itself must block too, or the sound plays over a human call.
  private blocked(): boolean {
    return (
      this.ending ||
      this.bridged ||
      this.handoverTone ||
      this.transferState === "dialling" ||
      this.transferState === "talking"
    );
  }

  private working(now: number): boolean {
    if (this.thinking || this.tools.size > 0) return true;
    // Realtime models enter "thinking" only around tool calls, so the reply
    // gap is taken from the caller's turn ending until the agent speaks.
    return (
      this.mode === "realtime" &&
      this.turnEndedAt !== null &&
      now - this.turnEndedAt < WORKING_MAX_MS
    );
  }

  private satisfied(now: number): boolean {
    if (this.config.when === "always") return true;
    if (this.config.when === "silent") return !this.agentAudible;
    return this.working(now) && !this.agentAudible && !this.userSpeaking;
  }

  evaluate(now = Date.now()): GateDecision {
    if (
      this.blocked() ||
      (this.initializing && this.config.when !== "always") ||
      !this.satisfied(now)
    ) {
      this.satisfiedSince = null;
      return { open: false, waitMs: null };
    }
    const delay = this.config.when === "always" ? 0 : this.config.delayMs;
    this.satisfiedSince ??= now;
    const held = now - this.satisfiedSince;
    return held >= delay ? { open: true, waitMs: 0 } : { open: false, waitMs: delay - held };
  }
}

/**
 * Reads from a pre-scaled buffer, looping, with a linear fade. Gain is applied
 * per sample only while a fade runs; at full level a frame is a slice copy.
 */
export class LoopReader {
  private gain = 0;
  private target = 0;
  private readonly fadeInStep = 1 / ((SAMPLE_RATE * FADE_IN_MS) / 1000);
  private readonly fadeOutStep = 1 / ((SAMPLE_RATE * FADE_OUT_MS) / 1000);

  constructor(
    private samples: Int16Array,
    public pos = 0,
  ) {}

  setSamples(samples: Int16Array): void {
    this.samples = samples;
    this.pos %= samples.length;
  }

  setOpen(open: boolean): void {
    this.target = open ? 1 : 0;
  }

  /** Fully faded out with the gate shut: nothing left to send. */
  get silent(): boolean {
    return this.gain === 0 && this.target === 0;
  }

  get level(): number {
    return this.gain;
  }

  fill(out: Int16Array): void {
    const len = this.samples.length;
    if (this.gain === 1 && this.target === 1) {
      let offset = 0;
      while (offset < out.length) {
        const take = Math.min(out.length - offset, len - this.pos);
        out.set(this.samples.subarray(this.pos, this.pos + take), offset);
        this.pos = (this.pos + take) % len;
        offset += take;
      }
      return;
    }
    for (let i = 0; i < out.length; i++) {
      if (this.gain !== this.target) {
        // Snap the ends: summed float steps stop just short of 0 or 1.
        this.gain =
          this.target > this.gain
            ? this.gain + this.fadeInStep > 1 - 1e-9 ? 1 : this.gain + this.fadeInStep
            : this.gain - this.fadeOutStep < 1e-9 ? 0 : this.gain - this.fadeOutStep;
      }
      out[i] = Math.round(this.samples[this.pos] * this.gain);
      this.pos = this.pos + 1 === len ? 0 : this.pos + 1;
    }
  }
}

function assetPath(sound: string): string {
  const name = `assets/background/${sound}-16k.wav`;
  // tsup emits dist/lib/, one level deeper than lib/ in the source tree.
  for (const relative of [`../${name}`, `../../${name}`]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(`background audio: ${name} not found from ${import.meta.url}`);
}

const scaledCache = new Map<string, Int16Array>();

/** The asset scaled to one volume, shared by every player in the process. */
export function scaledAsset(config: BackgroundAudioConfig): Int16Array {
  const key = `${config.sound}:${config.volume}`;
  const cached = scaledCache.get(key);
  if (cached) return cached;
  const { pcm, sampleRate } = decodeWav(readFileSync(assetPath(config.sound)));
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`background audio: ${config.sound} is ${sampleRate} Hz, not ${SAMPLE_RATE}`);
  }
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(pcm.readInt16LE(i * 2) * config.volume);
  }
  scaledCache.set(key, samples);
  return samples;
}

export class BackgroundAudioPlayer {
  private gate: BackgroundGate;
  private reader: LoopReader;
  private source: AudioSource | null = null;
  private starting = false;
  private closed = false;
  private silenced = false;
  private session: voice.AgentSession | null = null;
  private wake: (() => void) | null = null;
  private open = false;
  private plays = 0;
  private sentFrames = 0;

  constructor(
    private config: BackgroundAudioConfig,
    private getRoom: () => Room | null | undefined,
    private isBridged: () => boolean,
  ) {
    this.gate = new BackgroundGate(config);
    const samples = scaledAsset(config);
    // A random start, so callers do not all hear the same few seconds.
    this.reader = new LoopReader(samples, Math.floor(Math.random() * samples.length));
  }

  /** Publish the track and start the loop. Call once the room is connected. */
  async start(): Promise<void> {
    if (this.source || this.starting || this.closed) return;
    const room = this.getRoom();
    const localParticipant = room?.isConnected ? room.localParticipant : undefined;
    if (!room || !localParticipant) {
      logger.warn({}, "background audio: room not connected, track not published");
      return;
    }
    this.starting = true;
    try {
      const source = new AudioSource(SAMPLE_RATE, 1, QUEUE_MS);
      const track = LocalAudioTrack.createAudioTrack("background-audio", source);
      await localParticipant.publishTrack(
        track,
        // Never SOURCE_MICROPHONE: the session's RoomIO and transcript sync
        // key on the microphone track. See fallback-message.ts.
        new TrackPublishOptions({ source: TrackSource.SOURCE_UNKNOWN }),
      );
      if (this.closed) {
        await source.close();
        return;
      }
      this.source = source;
      room.once(RoomEvent.Disconnected, () => this.close());
      void this.runLoop();
      logger.info(
        { when: this.config.when, volume: this.config.volume, delayMs: this.config.delayMs },
        "background audio track published",
      );
    } catch (e) {
      logger.error({ e }, "background audio: failed to publish track");
    } finally {
      this.starting = false;
    }
  }

  attachSession(session: voice.AgentSession, mode: VoiceMode): void {
    if (this.closed || session === this.session) return;
    this.session = session;
    this.gate.startSession(mode, session.agentState);
    session.on(
      voice.AgentSessionEventTypes.AgentStateChanged,
      (ev: voice.AgentStateChangedEvent) => {
        if (session !== this.session) return;
        this.gate.noteAgentState(ev?.newState);
        this.notify();
      },
    );
    session.on(
      voice.AgentSessionEventTypes.UserStateChanged,
      (ev: voice.UserStateChangedEvent) => {
        if (session !== this.session) return;
        this.gate.noteUserState(ev?.newState);
        this.notify();
      },
    );
    this.notify();
  }

  /** Another agent's settings. Null keeps the track but sends nothing. */
  configure(config: BackgroundAudioConfig | null): void {
    this.silenced = config === null;
    if (config) {
      this.config = config;
      this.reader.setSamples(scaledAsset(config));
      this.gate.reconfigure(config);
    }
    logger.info({ silenced: this.silenced, when: config?.when }, "background audio reconfigured");
    this.notify();
  }

  setTransferState(state: TransferState): void {
    this.gate.setTransferState(state);
    this.notify();
  }

  setHandoverTone(active: boolean): void {
    this.gate.setHandoverTone(active);
    this.notify();
  }

  toolStarted(): () => void {
    const id = this.gate.toolStarted();
    this.notify();
    return () => {
      this.gate.toolFinished(id);
      this.notify();
    };
  }

  noteEnding(): void {
    this.gate.setEnding();
    this.notify();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.notify();
    if (this.source) {
      logger.info(
        { plays: this.plays, playedMs: (this.sentFrames * FRAME_SAMPLES * 1000) / SAMPLE_RATE },
        "background audio closed",
      );
    }
    const source = this.source;
    this.source = null;
    source?.close().catch((e) => logger.debug({ e }, "background audio: source close failed"));
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private idle(waitMs: number | null): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      this.wake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      if (waitMs !== null) {
        timer = setTimeout(() => {
          this.wake = null;
          resolve();
        }, Math.max(1, waitMs));
      }
    });
  }

  /**
   * While shut and faded out, nothing is written and no timer runs. The
   * native AudioSource feeds the encoder 10 ms of silence whenever its queue
   * is empty, so the track needs no keep-alive frames.
   */
  private async runLoop(): Promise<void> {
    while (!this.closed && this.source) {
      this.gate.setBridged(this.isBridged());
      const decision: GateDecision = this.silenced
        ? { open: false, waitMs: null }
        : this.gate.evaluate();
      if (decision.open !== this.open) {
        this.open = decision.open;
        if (decision.open) this.plays += 1;
        logger.debug({ when: this.config.when }, `background audio ${decision.open ? "on" : "off"}`);
      }
      this.reader.setOpen(decision.open);
      if (this.reader.silent) {
        await this.idle(decision.waitMs);
        continue;
      }
      const data = new Int16Array(FRAME_SAMPLES);
      this.reader.fill(data);
      try {
        await this.source.captureFrame(new AudioFrame(data, SAMPLE_RATE, 1, FRAME_SAMPLES));
        this.sentFrames += 1;
      } catch (e) {
        if (!this.closed) logger.warn({ e }, "background audio: captureFrame failed, stopping");
        break;
      }
    }
  }
}

/** What the worker and the voice runtime use. A no-op until a config applies. */
export interface BackgroundAudioControl {
  /** Publish the track, if a config applies. Call once the room is connected. */
  start(): void;
  attachSession(session: voice.AgentSession, mode: VoiceMode): void;
  /** Another agent took over: apply its options. */
  configure(options: any): void;
  setTransferState(state: TransferState): void;
  setHandoverTone(active: boolean): void;
  /** A tool call started. Call the returned function when it settles. */
  toolStarted(): () => void;
  noteEnding(): void;
  close(): void;
}

/**
 * Builds a player only once some agent on the call has the option, so a call
 * without it reads no file and publishes no track. Holds call-wide state for
 * a player built later, after a handover to an agent that has the option.
 */
export function createBackgroundAudio(
  options: any,
  deps: { getRoom: () => Room | null | undefined; isBridged: () => boolean },
): BackgroundAudioControl {
  let player: BackgroundAudioPlayer | null = null;
  let started = false;
  let closed = false;
  let transferState: TransferState = "none";
  let handoverTone = false;
  let ending = false;
  let session: { session: voice.AgentSession; mode: VoiceMode } | null = null;

  const build = (config: BackgroundAudioConfig) => {
    try {
      player = new BackgroundAudioPlayer(config, deps.getRoom, deps.isBridged);
    } catch (e) {
      // A missing or bad asset costs the sound, never the call.
      logger.error({ e }, "background audio: player not built");
      return;
    }
    player.setTransferState(transferState);
    player.setHandoverTone(handoverTone);
    if (ending) player.noteEnding();
    if (session) player.attachSession(session.session, session.mode);
    if (started) void player.start();
  };

  const initial = backgroundConfigFromOptions(options);
  if (initial) build(initial);

  return {
    start() {
      started = true;
      if (player && !closed) void player.start();
    },
    attachSession(s, mode) {
      session = { session: s, mode };
      player?.attachSession(s, mode);
    },
    configure(nextOptions) {
      if (closed) return;
      const config = backgroundConfigFromOptions(nextOptions);
      if (player) player.configure(config);
      else if (config) build(config);
    },
    setTransferState(state) {
      transferState = state;
      player?.setTransferState(state);
    },
    setHandoverTone(active) {
      handoverTone = active;
      player?.setHandoverTone(active);
    },
    toolStarted() {
      return player ? player.toolStarted() : () => {};
    },
    noteEnding() {
      ending = true;
      player?.noteEnding();
    },
    close() {
      closed = true;
      player?.close();
    },
  };
}
