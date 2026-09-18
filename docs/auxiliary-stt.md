# Auxiliary STT — a second opinion on the caller (`options.stt.aux`) and an audit of the agent (`options.tts.output`)

An agent can run an **independent speech-recognition engine over the call's audio** alongside its own recognition, on either side of the conversation:

- **`options.stt.aux`** — over the **caller's** audio. Every final transcript the auxiliary engine produces is logged in the call's transaction log as a `user-aux` entry, next to the primary `user` entry for the same speech, and its consumption is metered as its own `stt-aux` usage component.
- **`options.tts.output`** — over the **agent's own** audio: what the caller actually hears, whether synthesised by the pipeline TTS or produced by a realtime model. Each final transcript is logged as an `agent-speech` entry, next to the `agent` entry the model produced, and metered as `stt-output`. This is an audit of what the agent *said* against what it *thought it said* — a garbled synthesis, a mispronounced name, a realtime model whose own transcript of its output drifts from the audio.

Both engines are **observation only**: nothing they produce reaches the model. **Nothing is installed on a call unless the option is set**: the workers build a tap only for a configured option, and never touch the audio path otherwise.

It works on both voice workers and in both voice modes:

| Model family | Realtime (speech-to-speech) | Pipeline (STT → LLM → TTS) |
|---|---|---|
| `livekit:` | ✅ second engine next to the model's own transcription | ✅ second engine next to the pipeline STT |
| `pipecat:` | ✅ | ✅ |
| `ultravox:` (native driver), `jambonz:`, `text:` | ❌ rejected at save time (`Model … does not support auxiliary STT`) | — |

## Configuration

Both options have the **same shape as `options.stt`** (`vendor`, `language`), plus `enabled`. The caller side:

```json
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "options": {
    "stt": {
      "language": "en-GB",
      "aux": { "vendor": "assemblyai" }
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Set `false` to switch the auxiliary engine off without removing the block. |
| `vendor` | the platform's default STT engine (Deepgram) | Same semantics as `stt.vendor`: a vendor name, optionally scoped as `vendor/model[:lang]` (e.g. `deepgram/nova-2:en`). LiveKit offers `deepgram`, `assemblyai`, `cartesia` (via LiveKit Inference; Deepgram only under `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS`); Pipecat offers `deepgram` and `google`. |
| `language` | `stt.language`, then `tts.language` | Language hint for the auxiliary engine (`Language` schema). The "no fixed language" sentinels (`any`, `multi`, …) are accepted and mean "let the engine decide", as for `stt.language`. |

`{}` (or `true`) enables the engine with defaults. The block is validated when the agent is saved: unknown fields, a nested block, a non-boolean `enabled`, a malformed vendor string or a non-BCP-47 language are rejected with a 400. A vendor the *worker* cannot build (say `google` on LiveKit) is not caught at save time: the worker logs a warning and the call runs without the second opinion.

The agent side is the same block under `tts`, and defaults its language to `tts.language` first, since that is the language the agent speaks:

```json
"tts": { "vendor": "ultravox", "voice": "Ciara", "output": { "vendor": "deepgram" } }
```

Models: `GET /models` advertises `hasAuxStt` and `hasOutputStt` per model (both true for `livekit:` and `pipecat:`), so a UI can offer each option only where it is accepted.

## What gets logged

- Each **final** transcript segment from a side engine becomes one transaction-log entry — type **`user-aux`** for the caller side, **`agent-speech`** for the agent side — with `isFinal: true` and `data` = the text, timestamped when the segment arrived. Interim results are not logged.
- The primary `user` and `agent` entries are unchanged. Consumers that compare the two should align them by `createdAt`: a side engine finalises per speech segment, whereas a realtime model or the pipeline STT/TTS may log one entry per turn, so one primary entry can correspond to several side entries.
- The entries follow the same path as every other transcript entry — streamed live when the listener sets `streamLog`, otherwise batched onto the call record at the end — and the live progress socket carries them as `{ "user-aux": "<text>", … }` / `{ "agent-speech": "<text>", … }`. Front-ends that render transcripts by type should decide how (or whether) to show the new types; the platform does not merge them into `user` / `agent`.
- On the agent side only the agent's own speech is audited: the transfer confidence tone, a fixed fallback announcement and relayed audio from a bridged peer are not fed to the engine.

## Lifecycle

- Each engine is armed once the agent session is up: the caller side on the caller's audio only, the agent side on the agent's own output only.
- **Agent handover** (`transfer_agent`, or a hand-back after a bridged transfer): both engines are re-armed with the *incoming* agent's own options — an agent without an option switches that side off for the rest of the call.
- **Consultative transfer** (LiveKit): while the caller is on hold during the consultation, caller-side transcripts are suppressed, matching the primary transcript; the consult conversation itself happens in the consult session and is not audited.
- **Bridged transfer**: when the agent's media is detached and the caller talks to a human, both engines are stopped — there is no agent transcript left to second-guess, the agent is no longer speaking, and the human↔human segment has its own option, [`bridgedTransferTranscribe`](./call-transfers.md#transcribing-the-bridged-segment-bridgedtransfertranscribe). A WebRTC-origin transfer relay on Pipecat silences the caller-side engine in the same way.
- An engine stops when the caller leaves or the call ends. A failure inside it (vendor error, rejected credentials, unsupported vendor, no audio track) is logged and never affects the call — and, see below, meters nothing.

## Billing

A side engine is a real cost on every voice mode — including realtime models, whose *own* recognition is bundled into the model charge — so each is metered as its **own technology, `stt-aux` (caller side) or `stt-output` (agent side)**, never folded into the primary `stt` meter:

| Row | `technology` | `provider` | `detail` | `unit` | What is counted |
|---|---|---|---|---|---|
| audio | `stt-aux` / `stt-output` | the engine's vendor (e.g. `assemblyai`) | `vendor/model` where known | `milliseconds` | Audio the engine accepted, silence included — the basis streaming STT vendors bill on. On LiveKit this is the engine's own usage report (the same `metrics_collected` event the primary STT meter reads), which counts only audio actually sent to the vendor, so an engine that never connects meters nothing. On Pipecat, whose STT services report no such figure, it is the audio streamed to the engine, metered only once the engine has returned its first transcript in the call; an engine that never does meters nothing. |
| text | `stt-aux` / `stt-output` | as above | as above | `characters` | Characters in the final transcripts the engine returned. |

Rows are attributed to the agent call (the session's own call record, like the model's token and TTS meters) and finalised when it ends; a handover carries the running totals onto the continuation call.

**Rate cards must price the components explicitly.** `GET /api/rate-components` advertises one `stt-aux:<engine>` and one `stt-output:<engine>` component per STT engine (dimension `stt`, units `minute` | `character`) alongside the primary `stt:<engine>` components; a line keyed on `{ technology: "stt", provider }` does *not* match them, and a card with no such line leaves those rows uncosted (`no_line`), visible as `uncostedMeters` in `GET /api/usage`. This is deliberate: an operator decides whether a side engine is priced like primary STT, at a premium, or given away, and the usage report shows it as its own line either way. Filter with `GET /api/usage?technology=stt-aux` or `technology=stt-output`.

## Implementation notes

Neither tap fetches audio the worker does not already hold: no extra room subscription, no second media stream.

- **LiveKit worker, caller side** — [`agents/livekit/lib/aux-stt.ts`](../agents/livekit/lib/aux-stt.ts). The worker already holds its own connection to the room and the session already receives the caller's track, so it opens one extra rtc-node `AudioStream` on that same received track — which at the FFI layer is one more in-process sink on the one decoded WebRTC track, exactly what the session's own input is — and pumps it into a fresh STT stream built by the pipeline's own resolution with `options.stt.aux` standing in for `options.stt`. The `AgentSession` is untouched.
- **LiveKit worker, agent side** — [`agents/livekit/lib/output-stt.ts`](../agents/livekit/lib/output-stt.ts). The agent's outbound audio is a stream of frames the process itself produces, so the audit is a tee on the session's audio output: an `AudioOutput` wrapper installed as `session.output.audio` that forwards every frame to the real participant output and copies it to the STT stream — the same construction the SDK's own recorder uses. Nothing touches the room.
- **Pipecat worker** — [`agents/pipecat/pipecat_aplisay/aux_stt.py`](../agents/pipecat/pipecat_aplisay/aux_stt.py). One pass-through tap class serves both sides: on the caller's `InputAudioRawFrame`s right after `transport.input()` (behind the WebRTC relay tap), and on the agent's `TTSAudioRawFrame`s immediately before `transport.output()`. Each passes every frame through untouched and copies its own class of audio frame into a side STT-only pipeline (`SttStream`, shared with the bridged-segment transcription), so nothing a side service emits — transcripts, metrics, settings — can enter the main chain or be mistaken for the primary STT's.
- Transaction-log types: `user-aux` (schema version 64) and `agent-speech` (schema version 65) are values of `transaction_logs.type`; a `DB_FORCE_SYNC` boot adds them.
