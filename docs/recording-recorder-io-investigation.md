# RecorderIO investigation (LiveKit Agents pipeline recording)

This document summarizes how **RecorderIO** in `@livekit/agents` works and how we could use it for call recording instead of (or in addition to) the current room-listener approach.

---

## What RecorderIO is

RecorderIO is a component in the LiveKit Agents **Node.js** SDK that records audio by **teeing off the agent pipeline** rather than subscribing to room tracks separately.

- **Location (agents-js):** `agents/src/voice/recorder_io/recorder_io.ts`
- **Behaviour:**
  - It wraps the session’s **audio input** and **audio output** with intercepting classes:
    - `RecorderAudioInput`: wraps `AudioInput`, passes frames through and accumulates them when `recorderIO.recording` is true.
    - `RecorderAudioOutput`: wraps `AudioOutput`, passes frames through and accumulates them on `captureFrame()`, then flushes to the recorder on `onPlaybackFinished()`.
  - So the same streams the agent hears (input) and speaks (output) are what get recorded—no separate room subscription.
- **Output:** RecorderIO encodes to **stereo OGG/Opus** via FFmpeg and writes to a **local file path** (`outputPath`). It does not stream to GCS or support encryption out of the box.
- **Lifecycle:**
  - You must call `recordInput(audioInput)` and `recordOutput(audioOutput)` to wrap the real I/O, then assign `session.input.audio = recorderIO.recordInput(realInput)` and `session.output.audio = recorderIO.recordOutput(realOutput)` **before** the session starts processing.
  - `recorderIO.start(outputPath)` starts recording; `recorderIO.close()` stops it and finishes the file.

In the SDK, this is wired inside `AgentSession.start()` when:

- `this.input.audio` and `this.output.audio` are set (by RoomIO), and  
- `this._enableRecording` is true, and  
- `getJobContext().sessionDirectory` is set.

Then the session creates a `RecorderIO`, wraps input/output, and calls `recorderIO.start()` with a path like `${sessionDir}/audio.ogg`.

---

## Current limitation: RecorderIO not in our SDK version

Our project uses **@livekit/agents@^1.0.20**. RecorderIO was added in **@livekit/agents@1.0.25** (“Add RecorderIO for stereo audio recording”, [PR #876](https://github.com/livekit/agents-js/pull/876)). The 1.0.20 build does not include the `recorder_io` package or the `_recorderIO` / `_enableRecording` / `sessionDirectory` wiring in `agent_session.ts`.

So we **cannot** use RecorderIO without upgrading to **@livekit/agents@1.0.25** or later (and ensuring the runtime/API remain compatible).

---

## How we could use RecorderIO later

1. **Upgrade @livekit/agents** to a version that ships RecorderIO and wires it when `record: true` and a session directory is available.
2. **Provide a session directory** in our job/worker so the SDK can call `recorderIO.start()` with a path like `sessionDir/audio.ogg`. We would need to ensure the job context (or equivalent) exposes something the SDK uses as `sessionDirectory` (e.g. a per-call temp dir).
3. **Post-process and upload:**
   - Let RecorderIO write `audio.ogg` to the session directory.
   - On session end, read the OGG file, optionally re-encrypt (or leave as-is), and upload to GCS at a path we use as `recordingId`.
   - Then delete the local file and use the same `GET /calls/{callId}/recording` and metadata flow we have today.

Alternatively, the SDK would need to support a **custom recorder** (e.g. a writable stream or callback instead of a file path) so we could stream encoded audio directly to GCS with our encryption without a local OGG file. That would require a change in agents-js.

---

## Comparison with current approach

| Aspect | Room listener (current) | RecorderIO (if we upgrade) |
| ------ | ----------------------- | -------------------------- |
| Source of audio | Room tracks (TrackSubscribed + already-subscribed) | Pipeline tee (input + output streams) |
| Timing / reliability | We fixed timing (start before session, handle already-subscribed). | No room timing issues; exactly what the agent hears/speaks. |
| Format | Raw PCM, then our encryption, then GCS stream | OGG/Opus to local file; we would upload (and optionally re-encrypt) after. |
| Encryption | Built-in (AES-256-GCM) in our pipeline. | Would be in post-step (encrypt file before upload) or future SDK support. |
| SDK version | Works with current @livekit/agents. | Requires an agents version that includes RecorderIO. |

---

## Implementation (current)

We upgraded to **@livekit/agents@^1.0.25** and use RecorderIO when recording is enabled:

- The worker passes `record: true` to `session.start()` and does not start the room-listener recording.
- The SDK writes stereo OGG/Opus to the job session directory (`ctx.sessionDirectory/audio.ogg`).
- On cleanup we upload that file to GCS at `prefix/{callId}.ogg`, call `setCallRecordingData`, and delete the local file. Recordings are stored as **OGG** and are **not encrypted** on this path (encryption/key/stereo options are not applied to RecorderIO).

---

## References

- agents-js RecorderIO: `agents/src/voice/recorder_io/recorder_io.ts`
- AgentSession wiring: `agents/src/voice/agent_session.ts` (search for `_recorderIO`, `recordInput`, `recordOutput`, `_enableRecording`, `sessionDirectory`)
- Job context session directory: `agents/src/job.ts` (`sessionDirectory` / `_sessionDirectory`)
