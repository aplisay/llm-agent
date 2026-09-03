# Auxiliary ("second opinion") STT — `options.stt.aux`

An agent can run a **second, independent speech-recognition engine over the caller's audio** alongside its own recognition. Every final transcript the auxiliary engine produces is logged in the call's transaction log as a `user-aux` entry, next to the primary `user` entry for the same speech, and its consumption is metered as its own `stt-aux` usage component.

The auxiliary engine is **observation only**: nothing it produces reaches the model. It exists so two recognitions of the same audio can be compared — for evaluating an STT vendor before switching to it, for measuring how well a realtime model's built-in transcription holds up against a dedicated engine, or for keeping an independent record of what the caller said.

It works on both voice workers and in both voice modes:

| Model family | Realtime (speech-to-speech) | Pipeline (STT → LLM → TTS) |
|---|---|---|
| `livekit:` | ✅ second engine next to the model's own transcription | ✅ second engine next to the pipeline STT |
| `pipecat:` | ✅ | ✅ |
| `ultravox:` (native driver), `jambonz:`, `text:` | ❌ rejected at save time (`Model … does not support auxiliary STT`) | — |

## Configuration

`options.stt.aux` has the **same shape as `options.stt`** (`vendor`, `language`), plus `enabled`:

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

`{}` (or `true`) enables the engine with defaults. The block is validated when the agent is saved: unknown fields, a nested `aux`, a non-boolean `enabled`, a malformed vendor string or a non-BCP-47 language are rejected with a 400. A vendor the *worker* cannot build (say `google` on LiveKit) is not caught at save time: the worker logs a warning and the call runs without the second opinion.

## What gets logged

- Each **final** transcript segment from the auxiliary engine becomes one transaction-log entry of type **`user-aux`** with `isFinal: true` and `data` = the text, timestamped when the segment arrived. Interim results are not logged.
- The primary `user` entries are unchanged. Consumers that compare the two should align them by `createdAt`: an auxiliary engine finalises per speech segment, whereas a realtime model or the pipeline STT may log one entry per turn, so one `user` entry can correspond to several `user-aux` entries.
- The entries follow the same path as every other transcript entry — streamed live when the listener sets `streamLog`, otherwise batched onto the call record at the end — and the live progress socket carries them as `{ "user-aux": "<text>", isFinal, callId, timestamp }`. Front-ends that render transcripts by type should decide how (or whether) to show the new type; the platform does not merge it into `user`.

## Lifecycle

- The engine is armed once the agent session is up, on the caller's audio only (never the agent's).
- **Agent handover** (`transfer_agent`, or a hand-back after a bridged transfer): the auxiliary engine is re-armed with the *incoming* agent's own `options.stt.aux` — an agent without the option switches it off for the rest of the call.
- **Consultative transfer** (LiveKit): while the caller is on hold during the consultation, auxiliary transcripts are suppressed, matching the primary transcript.
- **Bridged transfer**: when the agent's media is detached and the caller talks to a human, the auxiliary engine is stopped — there is no agent transcript left to second-guess, and the human↔human segment has its own option, [`bridgedTransferTranscribe`](./call-transfers.md#transcribing-the-bridged-segment-bridgedtransfertranscribe). A WebRTC-origin transfer relay on Pipecat silences the auxiliary engine in the same way.
- The engine stops when the caller leaves or the call ends. A failure inside it (vendor error, unsupported vendor, no audio track) is logged and never affects the call.

## Billing

The auxiliary engine is a real cost on every voice mode — including realtime models, whose *own* recognition is bundled into the model charge — so it is metered as its **own technology, `stt-aux`**, never folded into the primary `stt` meter:

| Row | `technology` | `provider` | `detail` | `unit` | What is counted |
|---|---|---|---|---|---|
| audio | `stt-aux` | the aux vendor (e.g. `assemblyai`) | `vendor/model` where known | `milliseconds` | Audio actually streamed to the auxiliary engine, silence included — the basis streaming STT vendors bill on. Measured by the worker at the point it hands audio to the engine. |
| text | `stt-aux` | as above | as above | `characters` | Characters in the final transcripts the engine returned. |

Rows are attributed to the agent call (the session's own call record, like the model's token and TTS meters) and finalised when it ends; a handover carries the running totals onto the continuation call.

**Rate cards must price the component explicitly.** `GET /api/rate-components` advertises one `stt-aux:<engine>` component per STT engine (dimension `stt`, units `minute` | `character`) alongside the primary `stt:<engine>` components; a line keyed on `{ technology: "stt", provider }` does *not* match `stt-aux` rows, and a card with no `stt-aux` line leaves them uncosted (`no_line`), visible as `uncostedMeters` in `GET /api/usage`. This is deliberate: an operator decides whether the second opinion is priced like primary STT, at a premium, or given away, and the usage report shows it as its own line either way. Filter with `GET /api/usage?technology=stt-aux`.

## Implementation notes

- **LiveKit worker** — [`agents/livekit/lib/aux-stt.ts`](../agents/livekit/lib/aux-stt.ts). The worker already holds its own connection to the room, so it opens one extra `AudioStream` on the caller participant's audio track (the technique the bridged-segment transcription uses) and pumps it into a fresh STT stream built by the pipeline's own resolution with `options.stt.aux` standing in for `options.stt`. The `AgentSession` is untouched.
- **Pipecat worker** — [`agents/pipecat/pipecat_aplisay/aux_stt.py`](../agents/pipecat/pipecat_aplisay/aux_stt.py). An `AuxSttTap` sits right after `transport.input()` (behind the WebRTC relay tap). It passes every frame through untouched and copies each input audio frame into a side STT-only pipeline (`SttStream`, shared with the bridged-segment transcription), so nothing the auxiliary service emits — transcripts, metrics, settings — can enter the main chain or be mistaken for the primary STT's.
- Transaction-log type: `user-aux` is a new value of `transaction_logs.type` (schema version 64; a `DB_FORCE_SYNC` boot adds it).
