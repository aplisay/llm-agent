/**
 * Confidence tone for call transfers — see docs/call-transfers.md.
 *
 * While a transfer is in flight the caller would otherwise hear dead air: a
 * blind transfer spends seconds dialling the target before the SIP REFER
 * completes or the bridged participant's media is up, and a consultative
 * transfer parks the caller while the TransferAgent talks to the target in
 * the consultation room. The confidence tone fills those gaps with a
 * periodic comfort beep so the caller knows the call is still alive.
 *
 * Enabled per-agent via `options.transferTone` (`true` or an object — see
 * {@link toneConfigFromOptions}). When unset, no player is constructed and
 * behaviour is unchanged.
 *
 * Mechanism: {@link ConfidenceTonePlayer} lazily publishes a second audio
 * track from the agent participant into the caller's room (an
 * `AudioSource` + `LocalAudioTrack`, mixed for SIP participants by the
 * LiveKit SIP bridge) and runs a capture loop that synthesises 20 ms PCM
 * chunks of a sine-burst pattern. It is armed by `onTransfer` when a
 * transfer starts and derives play/stop from the worker's transfer state
 * (`setTransferState` is the single funnel every transfer path already
 * updates — blind bridge/REFER, consult start/accept/reject, destroy):
 *
 *   - `blind`   → tone while state == "dialling" (stops the moment the
 *     REFER completes / the bridged participant answers, both of which
 *     leave "dialling").
 *   - `consult` → tone while state is "dialling" or "talking" (the whole
 *     consultation), but ONLY in the gaps when neither the caller nor the
 *     local agent is speaking — the agent can still converse with the
 *     caller mid-consult and the tone must not stamp on that.
 *
 * Speaking detection rides the AgentSession's `AgentStateChanged` /
 * `UserStateChanged` events (same source the inactivity kick uses in
 * voice-agent-runtime.ts). A configurable quiet "grace" window after the
 * last speech keeps the tone from blipping into normal turn-taking pauses.
 *
 * Mirrors agents/pipecat/pipecat_aplisay/confidence_tone.py — keep the
 * option shape, defaults, and play conditions in sync across stacks.
 */

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
import type { TransferState } from "./transfer-handler.js";

export interface ToneConfig {
  frequency: number; // Hz
  onMs: number; // burst length
  offMs: number; // silence between bursts
  volume: number; // linear amplitude, 0..1
  graceMs: number; // quiet time required after speech before tone
}

// Defaults give a discreet UK-style comfort beep: a short 425 Hz burst
// every ~3 s at low volume. Keep aligned with the pipecat worker.
const DEFAULTS: ToneConfig = {
  frequency: 425,
  onMs: 250,
  offMs: 2750,
  volume: 0.15,
  graceMs: 1200,
};

// Telephony-standard rate; LiveKit resamples per-subscriber as needed.
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = (SAMPLE_RATE * 20) / 1000; // 20 ms
// Small internal AudioSource queue so a stop decision reaches the caller's
// ear within ~this many ms rather than the default 1000 ms buffer.
const QUEUE_MS = 200;

/**
 * Parse `options.transferTone` into a {@link ToneConfig}. Accepts `true`
 * (all defaults) or an object with any of `frequency`, `onMs`, `offMs`,
 * `volume`, `graceMs`; `enabled: false` (or any other falsy/malformed
 * value) disables the feature. Out-of-range values are clamped — agent
 * save-time validation in lib/database.js is the authoritative gate.
 */
export function toneConfigFromOptions(options: any): ToneConfig | null {
  const raw = options?.transferTone;
  if (raw === true) return { ...DEFAULTS };
  if (!raw || typeof raw !== "object" || raw.enabled === false) return null;
  const num = (value: unknown, dflt: number, lo: number, hi: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(hi, Math.max(lo, value))
      : dflt;
  return {
    frequency: num(raw.frequency, DEFAULTS.frequency, 50, 2000),
    onMs: Math.round(num(raw.onMs, DEFAULTS.onMs, 20, 10000)),
    offMs: Math.round(num(raw.offMs, DEFAULTS.offMs, 0, 60000)),
    volume: num(raw.volume, DEFAULTS.volume, 0, 1),
    graceMs: Math.round(num(raw.graceMs, DEFAULTS.graceMs, 0, 30000)),
  };
}

export class ConfidenceTonePlayer {
  private mode: "blind" | "consult" | null = null;
  /** Set once the armed transfer has been seen in an active state, so the
   * initial "none" (arm happens just before the state moves to "dialling")
   * isn't mistaken for completion. */
  private engagedSeen = false;
  private transferState: TransferState = "none";
  private agentSpeaking = false;
  private userSpeaking = false;
  private lastVoice = 0;
  /** Sample position within the on/off burst cycle (phase continuity). */
  private cyclePos = 0;
  private source: AudioSource | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private subscribedSession: voice.AgentSession | null = null;

  constructor(
    private config: ToneConfig,
    private getRoom: () => Room | null | undefined,
    private getSession: () => voice.AgentSession | null,
  ) {}

  /** Arm tone service for a transfer just initiated. */
  arm(mode: "blind" | "consult"): void {
    if (this.closed) return;
    this.mode = mode;
    this.engagedSeen = false;
    this.cyclePos = 0;
    // Treat arming as "voice just stopped": the agent has usually just
    // announced the transfer; the grace window keeps the tone off its heels.
    this.lastVoice = Date.now();
    this.subscribeSession();
    void this.ensureStarted();
    logger.info({ mode }, "confidence tone armed");
  }

  disarm(): void {
    if (this.mode !== null) {
      logger.info({ mode: this.mode }, "confidence tone disarmed");
    }
    this.mode = null;
  }

  /** Hook for the worker's setTransferState funnel. */
  notifyTransferState(state: TransferState): void {
    this.transferState = state;
  }

  close(): void {
    this.closed = true;
    this.mode = null;
    try {
      this.source?.close();
    } catch (e) {
      logger.debug({ e }, "confidence tone: source close failed");
    }
    this.source = null;
  }

  private subscribeSession(): void {
    const session = this.getSession();
    if (!session || session === this.subscribedSession) return;
    this.subscribedSession = session;
    session.on(
      voice.AgentSessionEventTypes.AgentStateChanged,
      (ev: voice.AgentStateChangedEvent) => {
        const speaking = ev?.newState === "speaking";
        if (speaking !== this.agentSpeaking) {
          this.agentSpeaking = speaking;
          this.lastVoice = Date.now();
        }
      },
    );
    session.on(
      voice.AgentSessionEventTypes.UserStateChanged,
      (ev: { newState?: string }) => {
        const speaking = ev?.newState === "speaking";
        if (speaking !== this.userSpeaking) {
          this.userSpeaking = speaking;
          this.lastVoice = Date.now();
        }
      },
    );
  }

  /** Publish the tone track and start the capture loop (idempotent). */
  private async ensureStarted(): Promise<void> {
    if (this.source || this.closed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const room = this.getRoom();
      const localParticipant = room?.localParticipant;
      if (!localParticipant) {
        logger.warn({}, "confidence tone: no local participant to publish from");
        return;
      }
      try {
        const source = new AudioSource(SAMPLE_RATE, 1, QUEUE_MS);
        const track = LocalAudioTrack.createAudioTrack(
          "confidence-tone",
          source,
        );
        await localParticipant.publishTrack(
          track,
          new TrackPublishOptions({ source: TrackSource.SOURCE_UNKNOWN }),
        );
        this.source = source;
        room!.once(RoomEvent.Disconnected, () => this.close());
        void this.runLoop();
        logger.info({}, "confidence tone track published");
      } catch (e) {
        logger.error({ e }, "confidence tone: failed to publish track");
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private shouldPlay(): boolean {
    if (this.mode === null) return false;
    const state = this.transferState;
    const active =
      this.mode === "blind"
        ? state === "dialling"
        : state === "dialling" || state === "talking";
    if (active) {
      this.engagedSeen = true;
    } else {
      // Hard failures end service even if the transfer never got going
      // (e.g. argument validation threw before "dialling"); otherwise only
      // a transition OUT of the active set means the transfer concluded.
      if (this.engagedSeen || state === "failed" || state === "rejected") {
        this.disarm();
      }
      return false;
    }
    if (this.agentSpeaking || this.userSpeaking) {
      this.cyclePos = 0;
      return false;
    }
    if (Date.now() - this.lastVoice < this.config.graceMs) {
      this.cyclePos = 0;
      return false;
    }
    return true;
  }

  /** Next CHUNK_SAMPLES of the burst cycle as s16 mono PCM (in place). */
  private fillTone(buf: Int16Array): void {
    const cfg = this.config;
    const onSamples = Math.floor((SAMPLE_RATE * cfg.onMs) / 1000);
    const cycleSamples = Math.max(
      1,
      onSamples + Math.floor((SAMPLE_RATE * cfg.offMs) / 1000),
    );
    const amp = cfg.volume * 32767;
    const omega = (2 * Math.PI * cfg.frequency) / SAMPLE_RATE;
    const rampSamples = SAMPLE_RATE * 0.005; // 5 ms anti-click fade
    for (let i = 0; i < buf.length; i++) {
      const p = (this.cyclePos + i) % cycleSamples;
      if (p < onSamples) {
        const edge = Math.min(p, onSamples - 1 - p);
        const ramp = Math.min(1, edge / rampSamples);
        buf[i] = Math.round(amp * ramp * Math.sin(omega * p));
      }
    }
    this.cyclePos = (this.cyclePos + buf.length) % cycleSamples;
  }

  /**
   * Capture loop. `captureFrame` applies backpressure once the source's
   * internal queue (QUEUE_MS) is full, so this self-paces at realtime;
   * silence frames are captured while gated to keep the track continuous.
   */
  private async runLoop(): Promise<void> {
    while (!this.closed && this.source) {
      const data = new Int16Array(CHUNK_SAMPLES);
      if (this.shouldPlay()) {
        this.fillTone(data);
      }
      try {
        await this.source.captureFrame(
          new AudioFrame(data, SAMPLE_RATE, 1, CHUNK_SAMPLES),
        );
      } catch (e) {
        if (!this.closed) {
          logger.warn({ e }, "confidence tone: captureFrame failed, stopping");
        }
        break;
      }
    }
  }
}
