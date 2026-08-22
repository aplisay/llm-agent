/**
 * Fixed-message failover for LiveKit — `options.fallback.message`.
 *
 * Sits between `fallback.model` and `fallback.number` in the failover chain
 * (see `docs/agent-failover.md`): when the agent could not be brought up, play
 * the operator's announcement at the caller rather than dropping them into
 * dead air or straight onto a transfer.
 *
 * Two properties shape everything here.
 *
 * **The audio is cached, so playout makes no vendor call.** The announcement
 * cannot vary for a given configuration, so it is synthesised once, stored in
 * GCS keyed by a digest of its own content, and replayed from then on. That is
 * not just a latency win: because a cache hit calls no TTS vendor, it meters
 * no usage, so it needs no `Call` record, so it never reserves an agent
 * concurrency slot. Which matters enormously, because the single most useful
 * moment to play a fixed message is when the concurrency limiter is what
 * rejected the call — a playout that took a slot would defeat the feature it
 * implements. See `lib/fallback-message/CONTRACT.md`.
 *
 * **This path runs when things are already broken**, and often when the host is
 * loaded — load being one of the likelier reasons a session failed to start.
 * So it stays cheap and it never throws: every failure here degrades to
 * "caller does not get the announcement", handing control back to the fallback
 * chain to try `fallback.number`, rather than turning one failure into two.
 *
 * Mirrors `agents/pipecat/pipecat_aplisay/fallback_message.py` — keep the
 * resolution rules and playout semantics in step across stacks.
 */

import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  type Room,
} from "@livekit/rtc-node";
import { inference, type tts as ttsTypes } from "@livekit/agents";
import logger from "./logger.js";
import type { Agent } from "./api-client.js";
import { resolveVoiceMode } from "./voice-mode.js";
import {
  decodeWav,
  encodeWav,
  fallbackMessageKey,
  fetchCachedMessage,
  resolveFallbackMessage,
  storeCachedMessage,
  type ResolvedFallbackMessage,
} from "../agent-lib/fallback-message/index.js";

/** Frame size pushed to the room. 20 ms is the LiveKit/SIP convention. */
const FRAME_MS = 20;

/** `AudioSource` queue depth; `captureFrame` blocks once it is full, which is
 *  what paces the loop at realtime without a timer. Matches confidence-tone. */
const QUEUE_MS = 200;

/** Ceiling on synthesis. The caller is holding an already-failed call, so a
 *  hung TTS vendor must not add to their wait — give up and let the chain move
 *  on to `fallback.number`. */
const SYNTHESIS_TIMEOUT_MS = 10_000;

/** Hard ceiling on playout, so a pathological cached object cannot pin a room
 *  open indefinitely. Well clear of any sane announcement. */
const MAX_PLAYOUT_MS = 120_000;

export interface FallbackMessageAudio {
  pcm: Buffer;
  sampleRate: number;
  /** True when this came from GCS rather than a fresh vendor call. */
  cached: boolean;
}

/**
 * Resolve `options.fallback.message` for an agent, or `null` when the agent has
 * not configured one.
 *
 * A realtime agent's `options.tts` describes the model's own voice, not a TTS,
 * so its vendor/voice are not inherited — see `resolveFallbackMessage`. Keep
 * this decision identical to Pipecat's `fixed_message_for`: it feeds the cache
 * key, and disagreeing would split the shared cache in two.
 */
export function fallbackMessageFor(agent: Agent): ResolvedFallbackMessage | null {
  const inheritAgentTts =
    resolveVoiceMode(agent?.modelName ?? "", agent?.options) === "pipeline";
  return resolveFallbackMessage(agent?.options?.fallback?.message, agent?.options, {
    inheritAgentTts,
  });
}

/**
 * Build a TTS instance for the announcement.
 *
 * The message may name its own `vendor`/`voice`/`language` — the whole point
 * being that it can be spoken by a stack known to work when the agent's own is
 * what just failed. Rather than reimplement vendor selection, we hand
 * `buildPipelineTts` a *synthetic agent* whose `options.tts` is the message's
 * resolved settings. Every vendor the pipeline supports is therefore supported
 * here for free, and stays supported as vendors are added, with no second
 * catalogue to keep in step.
 *
 * `buildPipelineTts` returns either a configured TTS instance or a LiveKit
 * Inference model string; only the former can synthesise on its own, so a
 * string is turned into an `inference.TTS` here.
 */
async function buildMessageTts(
  agent: Agent,
  resolved: ResolvedFallbackMessage,
): Promise<ttsTypes.TTS> {
  // Imported lazily, as Pipecat's sibling does: the factory pulls in every
  // vendor plugin, and this path only needs it on a cache miss. Deferring it
  // keeps the cost off the common (cached) playout and off module load.
  const { buildPipelineTts } = await import("./voice-session-factory.js");

  const syntheticAgent = {
    ...agent,
    options: {
      ...(agent.options || {}),
      tts: {
        ...(agent.options?.tts || {}),
        ...(resolved.vendor ? { vendor: resolved.vendor } : {}),
        ...(resolved.voice ? { voice: resolved.voice } : {}),
        ...(resolved.language ? { language: resolved.language } : {}),
      },
    },
  } as Agent;

  const built = buildPipelineTts(syntheticAgent);
  if (typeof built !== "string") {
    return built as ttsTypes.TTS;
  }
  const [model, voice] = inference.parseTTSModelString(built);
  return new inference.TTS({
    model,
    ...(voice ? { voice } : {}),
    ...(resolved.language ? { language: resolved.language } : {}),
  }) as unknown as ttsTypes.TTS;
}

/**
 * Synthesise the announcement through the configured TTS.
 *
 * The usage this incurs is metered against the call that triggered it, through
 * the runtime's normal TTS accounting — which is the honest place for it: this
 * is the one call that actually paid a vendor for these characters. Every
 * later playout is a cache hit and costs nothing, so the announcement is billed
 * exactly once per distinct configuration rather than once per failed call.
 */
async function synthesise(
  agent: Agent,
  resolved: ResolvedFallbackMessage,
): Promise<{ pcm: Buffer; sampleRate: number }> {
  const tts = await buildMessageTts(agent, resolved);
  const stream = tts.synthesize(resolved.text);
  try {
    const frame = (await Promise.race([
      stream.collect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`fallback message synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms`)),
          SYNTHESIS_TIMEOUT_MS,
        ).unref?.(),
      ),
    ])) as AudioFrame;
    // `frame.data` is an Int16Array view; copy through its own byte range so a
    // pooled or offset-backed buffer cannot smuggle neighbouring audio in.
    const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    return { pcm: Buffer.from(pcm), sampleRate: frame.sampleRate };
  } finally {
    try {
      stream.close();
    } catch {
      // Closing a finished stream is best-effort; nothing here is worth failing on.
    }
  }
}

/**
 * Get the announcement audio: cache read, else synthesise and write through.
 *
 * Returns `null` if it could not be produced at all, which the caller should
 * treat as "no announcement available" and continue down the fallback chain.
 */
export async function loadFallbackMessageAudio(
  agent: Agent,
  resolved: ResolvedFallbackMessage,
): Promise<FallbackMessageAudio | null> {
  const key = fallbackMessageKey(resolved);

  const cached = await fetchCachedMessage({ key, logger });
  if (cached) {
    try {
      const { pcm, sampleRate } = decodeWav(cached);
      return { pcm, sampleRate, cached: true };
    } catch (e) {
      // A corrupt object should not condemn the caller to silence: fall through
      // and re-synthesise. The bad object stays until something overwrites or
      // expires it, which is fine — it is content-addressed, so the next writer
      // produces byte-identical audio anyway.
      logger.warn({ e, key }, "cached fallback message failed to decode; re-synthesising");
    }
  }

  let fresh: { pcm: Buffer; sampleRate: number };
  try {
    fresh = await synthesise(agent, resolved);
  } catch (e) {
    logger.error({ e, key }, "fallback message synthesis failed; no announcement available");
    return null;
  }

  if (!fresh.pcm.length) {
    logger.error({ key }, "fallback message synthesis produced no audio");
    return null;
  }

  // Write through, but do not make the caller wait for GCS — they are already
  // holding a failed call. A lost write just means the next call re-synthesises.
  void storeCachedMessage({ key, wav: encodeWav(fresh.pcm, fresh.sampleRate), logger }).catch(() => {});

  return { ...fresh, cached: false };
}

/**
 * Publish the announcement into the room and return once it has been played.
 *
 * Published as `SOURCE_MICROPHONE`, unlike the confidence tone, which must use
 * `SOURCE_UNKNOWN` to avoid being hijacked by the running session's RoomIO.
 * Here there is no session — that is the entire premise of this path — so
 * nothing can contend for the microphone source, and using it means the
 * announcement reaches the SIP bridge and any recording as ordinary agent
 * audio rather than as a second track that per-participant recording drops.
 *
 * The source is created at the audio's own sample rate rather than resampling
 * on the way in; LiveKit resamples to the transport's rate downstream, which
 * keeps this path to a download and a write.
 */
export async function playFallbackMessage(
  room: Room,
  audio: FallbackMessageAudio,
): Promise<boolean> {
  const localParticipant = room?.localParticipant;
  if (!localParticipant) {
    logger.warn({}, "fallback message: no local participant to publish from");
    return false;
  }

  const samplesPerFrame = Math.floor((audio.sampleRate * FRAME_MS) / 1000);
  const bytesPerFrame = samplesPerFrame * 2; // 16-bit mono
  let source: AudioSource | null = null;

  try {
    source = new AudioSource(audio.sampleRate, 1, QUEUE_MS);
    const track = LocalAudioTrack.createAudioTrack("fallback-message", source);
    await localParticipant.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    const deadline = Date.now() + MAX_PLAYOUT_MS;
    for (let offset = 0; offset < audio.pcm.length; offset += bytesPerFrame) {
      if (Date.now() > deadline) {
        logger.warn({ offset, total: audio.pcm.length }, "fallback message playout exceeded its ceiling; stopping");
        break;
      }
      const slice = audio.pcm.subarray(offset, offset + bytesPerFrame);
      // Pad the final partial frame: AudioFrame wants a whole frame, and a
      // short one would be interpreted as a rate change by the SIP resampler.
      // (`new Int16Array(n)` is zero-filled, so the padding is silence.)
      const data = new Int16Array(samplesPerFrame);
      // Copied byte-wise rather than through an Int16Array view of `slice`.
      // A view would require `slice.byteOffset` to be 2-byte aligned, and
      // nothing guarantees that: `pcm` is a subarray of a downloaded buffer,
      // and Node pools small allocations at arbitrary offsets. The view
      // constructor throws on a misaligned offset, so that spelling would
      // fail intermittently on cached audio depending on how the buffer
      // happened to be allocated.
      new Uint8Array(data.buffer).set(slice);
      // `captureFrame` blocks once the queue is full, pacing this at realtime.
      await source.captureFrame(new AudioFrame(data, audio.sampleRate, 1, samplesPerFrame));
    }

    // The loop returns as soon as the last frame is *queued*; wait for the
    // queue itself to drain or the caller loses the tail of the announcement.
    await source.waitForPlayout();
    logger.info(
      { bytes: audio.pcm.length, sampleRate: audio.sampleRate, cached: audio.cached },
      "fallback message played",
    );
    return true;
  } catch (e) {
    logger.error({ e }, "fallback message playout failed");
    return false;
  } finally {
    try {
      source?.close();
    } catch {
      // Best effort; the room teardown that follows will reclaim it anyway.
    }
  }
}

/**
 * Full fixed-message step: resolve, fetch-or-synthesise, play.
 *
 * @returns true when the caller heard the announcement. False means the chain
 *   should carry on to `fallback.number` exactly as if no message were set.
 */
export async function runFallbackMessage(room: Room, agent: Agent): Promise<boolean> {
  const resolved = fallbackMessageFor(agent);
  if (!resolved) return false;

  logger.info(
    { voice: resolved.voice, vendor: resolved.vendor, chars: resolved.text.length },
    "playing fixed fallback message",
  );

  const audio = await loadFallbackMessageAudio(agent, resolved);
  if (!audio) return false;

  return playFallbackMessage(room, audio);
}
