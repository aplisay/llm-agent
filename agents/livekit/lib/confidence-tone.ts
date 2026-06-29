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

// Resolved, internal tone parameters consumed by the generator below. NOT the
// public interface — `toneConfigFromOptions` maps the coarse shorthand onto
// these numeric values.
export interface ToneConfig {
  frequency: number; // Hz
  onMs: number; // burst length
  offMs: number; // silence between bursts
  volume: number; // linear amplitude, 0..1
  graceMs: number; // quiet time required after speech before tone
}

// The public `options.transferTone` interface is deliberately coarse — the
// tone *shape* (pitch, burst length, volume) is chosen from small discrete sets
// rather than free-form Hz/ms/amplitude. Only the silence timings
// (`gapMs`/`graceMs`) are continuous. This keeps the set of possible on-bursts
// tiny (one per frequency×length×volume combination) so the live sine generator
// below could later be swapped for a lookup of pre-generated PCM tone tables
// without any change to the agent-facing config. Keep these maps in sync with
// the Pipecat worker (agents/pipecat/pipecat_aplisay/confidence_tone.py) and
// lib/database.js.
// NB: these deliberately avoid telephony call-progress frequencies — the old
// `medium` 425 Hz is the UK/EU network tone (dial/busy/ringing all live at
// 425 Hz, just different cadences), and US progress uses 350/440/480/620 — and
// stay clear of the DTMF bands (697-941 / 1209-1633). A periodic 425 Hz burst on
// a SIP leg is easily swallowed by carrier/SBC call-progress handling or echo
// cancellation; 523/587/659 sit clear of both. (Pipecat confidence_tone.py and
// lib/database.js carry the same map — sync them if this resolves it.)
const FREQUENCY_HZ: Record<string, number> = { low: 523, medium: 587, high: 659 };
const LENGTH_MS: Record<string, number> = { short: 150, medium: 250, long: 400 };
// Linear amplitude, 0..1. `medium` of everything is the UK-style comfort beep.
const VOLUME_LEVEL: Record<string, number> = { low: 0.08, medium: 0.15, high: 0.3 };

// Defaults: a discreet UK-style comfort beep — a 250 ms 425 Hz burst every
// ~3 s at low volume. Keep aligned with the pipecat worker.
const DEFAULTS: ToneConfig = {
  frequency: FREQUENCY_HZ.medium,
  onMs: LENGTH_MS.medium,
  offMs: 2750,
  volume: VOLUME_LEVEL.medium,
  graceMs: 1200,
};

// Telephony-standard rate; LiveKit resamples per-subscriber as needed. (48 kHz
// was tried to "fix" SIP delivery and made it worse — total silence on the
// telephony leg vs the partial tone at 16 kHz — so keep ONE generator for both
// WebRTC and SIP. The suppression is downstream of the track, not the rate.)
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = (SAMPLE_RATE * 20) / 1000; // 20 ms
// Small internal AudioSource queue so a stop decision reaches the caller's
// ear within ~this many ms rather than the default 1000 ms buffer.
const QUEUE_MS = 200;
// Backstop for handover mode: a full-stack agent handover normally completes
// (new agent first speaks) in a few seconds. If the incoming agent never
// signals "speaking" — a stuck/failed start that didn't go through the catch
// path — cap the comfort tone so the caller isn't beeped at indefinitely.
const HANDOVER_MAX_MS = 25_000;

/**
 * Parse `options.transferTone` into a {@link ToneConfig}. Accepts `true`
 * (all defaults) or an object with any of:
 *   - `frequency` — one of `"low"` / `"medium"` / `"high"`
 *   - `length` — one of `"short"` / `"medium"` / `"long"`
 *   - `volume` — one of `"low"` / `"medium"` / `"high"`
 *   - `gapMs` — silence between bursts, milliseconds
 *   - `graceMs` — quiet time after speech before the tone (re)starts, ms
 * `enabled: false` (or any other falsy/malformed value) disables the feature.
 * Unrecognised enum values fall back to `"medium"` and out-of-range numbers
 * are clamped — agent save-time validation in lib/database.js is the
 * authoritative gate.
 */
export function toneConfigFromOptions(options: any): ToneConfig | null {
  const raw = options?.transferTone;
  if (raw === true) return { ...DEFAULTS };
  if (!raw || typeof raw !== "object" || raw.enabled === false) return null;
  const pick = (
    value: unknown,
    table: Record<string, number>,
    dflt: string,
  ): number =>
    typeof value === "string" && table[value.toLowerCase()] !== undefined
      ? table[value.toLowerCase()]
      : table[dflt];
  const num = (value: unknown, dflt: number, lo: number, hi: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(hi, Math.max(lo, value))
      : dflt;
  return {
    frequency: pick(raw.frequency, FREQUENCY_HZ, "medium"),
    onMs: pick(raw.length, LENGTH_MS, "medium"),
    offMs: Math.round(num(raw.gapMs, DEFAULTS.offMs, 0, 60000)),
    volume: pick(raw.volume, VOLUME_LEVEL, "medium"),
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
  /** True while covering a full-stack agent-to-agent handover gap. In this
   * mode play is gated only by speech grace, NOT by the transfer state machine
   * (there is no transfer; the caller drives start/stop via startHandover /
   * stopHandover). */
  private handover = false;
  /** Wall-clock start of the current handover, for the max-duration backstop. */
  private handoverStartedAt = 0;
  private agentSpeaking = false;
  private userSpeaking = false;
  private lastVoice = 0;
  /** Sample position within the on/off burst cycle (phase continuity). */
  private cyclePos = 0;
  private source: AudioSource | null = null;
  /** Whether the loop is currently writing tone (vs silence) frames. Tracked
   * only to log audible/silent transitions for diagnosis. */
  private emitting = false;
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
    this.handover = false;
  }

  /**
   * Start the comfort tone to cover the dead-air gap of a full-stack
   * agent-to-agent handover (the outgoing agent's session is torn down and the
   * incoming agent's model stack spins up — several seconds of silence). The
   * tone publishes its own room track, so it survives the session swap. Play is
   * gated only by speech grace here; the caller stops it via {@link stopHandover}
   * once the incoming agent takes over. Idempotent.
   */
  startHandover(): void {
    if (this.closed) return;
    this.handover = true;
    // `mode` is the "armed" sentinel the play/loop guards check; the actual
    // play condition is the `handover` branch in shouldPlay().
    this.mode = "blind";
    this.cyclePos = 0;
    this.handoverStartedAt = Date.now();
    // Grace: the outgoing agent usually just spoke (e.g. "putting you through").
    this.lastVoice = Date.now();
    void this.ensureStarted();
    logger.info({}, "confidence tone started for agent handover");
  }

  /** Stop a handover comfort tone (incoming agent has taken over, or the
   * handover failed). Idempotent. */
  stopHandover(): void {
    if (this.handover) {
      logger.info({}, "confidence tone stopped (agent handover complete)");
    }
    this.handover = false;
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
    if (!this.handover) {
      // Transfer-driven play: gated by the worker's transfer state machine.
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
    } else if (Date.now() - this.handoverStartedAt > HANDOVER_MAX_MS) {
      // Handover backstop: the incoming agent never signalled "speaking".
      this.stopHandover();
      return false;
    }
    // Handover mode falls straight through to the speech-grace gate below: it
    // plays continuously until the caller calls stopHandover().
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
      const play = this.shouldPlay();
      if (play !== this.emitting) {
        this.emitting = play;
        // One line per transition so a call log shows whether the tone is
        // actually generating audio toward the room (proves generation), vs
        // being gated by speech/state. If "now audible" appears but the caller
        // heard nothing, the loss is downstream (SIP egress mixing/delivery).
        logger.info(
          { mode: this.mode, state: this.transferState, handover: this.handover },
          play ? "confidence tone now audible" : "confidence tone now silent",
        );
      }
      if (play) {
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
