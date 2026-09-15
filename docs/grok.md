# xAI Grok

xAI sells two things the platform offers under the `xai` vendor segment:

- the Grok Voice Agent API, a speech-to-speech model over a WebSocket that
  listens, reasons and speaks in one stage. The platform offers it as the
  realtime row `pipecat:xai/grok-voice-think-fast-2.0`. The LiveKit row
  follows with the LiveKit worker upgrade;
- the Grok text models, served through an OpenAI-compatible chat completions
  endpoint. The platform offers them as `text:xai/<model>` rows for text
  agents and subagents, and two of them as Pipecat pipeline rows
  (`pipecat:xai/<model>`) for a cascaded voice agent.

All of them need one key on the API server and the Pipecat worker:
`XAI_API_KEY`. The older `GROK_API_KEY` name is accepted as a fallback.
Without a key the rows are not advertised.

## Rows

| Row | What it is |
|---|---|
| `pipecat:xai/grok-voice-think-fast-2.0` | The Grok voice model, realtime, on the Pipecat worker. Billed per minute. |
| `text:xai/grok-4.6` | The largest Grok text model, reasoning. |
| `text:xai/grok-4.3` | Reasoning, 1M context, the fast choice for tool use. |
| `text:xai/grok-4.20-0309-reasoning` | Reasoning, 1M context. |
| `text:xai/grok-4.20-0309-non-reasoning` | No reasoning, 1M context, the lowest latency. |
| `pipecat:xai/grok-4.3`, `pipecat:xai/grok-4.20-0309-non-reasoning` | The same two models as the LLM stage of a Pipecat STT, LLM, TTS pipeline. |

Only the pinned voice model id is offered. xAI's `grok-voice-latest` alias is
not a row, because a saved agent must not change model underneath a customer.

## The voice model

The Grok Voice Agent API is wire-compatible with OpenAI's Realtime API, with
a few xAI extensions the platform uses:

- a verbatim speech item, which speaks a fixed line exactly and, when marked
  uninterruptible, cannot be talked over. `greeting.text` and the
  `inactivity` message use it, so on this row those two are spoken word for
  word, which no other realtime row can promise;
- input transcription with xAI's `grok-transcribe`, always on, so the call's
  `user` transcript rows, the transfer summariser and the auxiliary STT
  comparison all work;
- a pronunciation map, output speed and idle check-in, reachable through
  `vendorSpecific.xai.session` below.

The model is fixed for the life of the WebSocket, so a `transfer_agent`
handover onto or off a Grok row always restarts the agent stack, as it does
for Ultravox. The conversation so far is carried into the new session.

### Text-output mode

None. The API has no text-only output: every form of a text modality request
was tried on 2026-09-15 and the model kept speaking. The row reports
`hasExternalTts: false`, and `options.tts.vendor` must be unset or `xai`. See
[realtime-external-tts.md](realtime-external-tts.md) for the rows that can
pair with an external TTS.

### Voices

`GET /models/pipecat:xai/grok-voice-think-fast-2.0/voices/any` lists the xAI
voices under the `xAI` vendor. The list comes from xAI's catalogue endpoint
(`GET https://api.x.ai/v1/tts/voices`), fetched once when the API server
starts, with a built-in list of the 26 documented voices as the fallback.
Every voice is multilingual, so all of them sit under the `any` locale and
the model speaks the language of the conversation whichever voice is chosen.
The default is `eve`.

The documented voices: ara, eve, leo, rex, sal, carina, zagan, helix, orion,
luna, iris, altair, zenith, perseus, helios, lux, kepler, rigel, cosmo,
celeste, ursa, sirius, lumen, castor, naksh and atlas. The catalogue may list
more (it listed `aurora` and `liora` on 2026-09-15). Each row carries xAI's
gender label.

`options.tts.voice` is validated against this list when the agent is saved.
That check matters more than usual: xAI accepts an unknown voice id without
an error and silently speaks with the default voice instead.

### Options on the voice row

| Option | Behaviour |
|---|---|
| `greeting.text` | Spoken exactly, uninterruptible. Caller audio is not detected until it ends. |
| `greeting.instructions` | A first response with per-response instructions, best-effort wording. |
| no greeting | The platform's opening instruction, so the agent still speaks first. |
| `inactivity` | The platform's idle detection; the message is spoken exactly. Repeat count and `hangup` unchanged. |
| `maxDuration` | The worker's hard stop, unchanged. |
| `timeExceededMessage` | Ultravox only, unchanged. |
| `dtmfTimeout`, `dtmfTerminator` | Digits become a user message and a new response. |
| functions, builtins | Function tools, run in the worker. Parallel calls are supported. Names on xAI's reserved list are rejected when the agent is saved (see below). |
| MCP servers | The worker is the MCP client and exposes MCP tools as function tools, as on every Pipecat realtime row. xAI-hosted MCP is not offered. |
| `transfer_agent` | A full restart of the agent stack with the transcript carried over. |
| Blind, consultative and bridged transfers | Unchanged. |
| `stt.aux`, `tts.output`, `recording`, `fallback.*` | Unchanged. |
| `stt.language` | The transcription language hint, and appended to the instructions as the language to speak. |
| `tts.language` | Appended to the instructions as the language to speak. |
| `tts.vendor` | Must be unset or `xai`. |
| `effort` | `none` and `low` send xAI's `none`; `medium`, `high`, `xhigh` and `max` send `high`. Unset leaves xAI's default, `high`, which costs no measurable latency on ordinary turns. |
| `temperature` | Ignored. The API has no temperature. |
| `voiceMode` | Must be `realtime` or unset. |

### `vendorSpecific.xai.session`

A free-form object deep-merged into every session update after the
platform's own mapping, so an explicit value here wins. Useful fields:

```json
{
  "vendorSpecific": {
    "xai": {
      "session": {
        "turn_detection": { "type": "server_vad", "silence_duration_ms": 350, "threshold": 0.7 },
        "audio": { "output": { "speed": 1.1 } },
        "replace": { "Aplisay": "Appli-say" },
        "voice": "a-voice-the-catalogue-does-not-list"
      }
    }
  }
}
```

- `turn_detection`: xAI's server VAD (`threshold`, `silence_duration_ms`,
  `prefix_padding_ms`). `idle_timeout_ms` turns on xAI's own check-in, which
  improvises its wording and would double up with `options.inactivity`; use
  one or the other.
- `audio.output.speed`: 0.7 to 1.5.
- `replace`: a pronunciation map applied before speech.
- `voice`: overrides the validated `tts.voice`, for a custom cloned voice id.
- `resumption`: has no effect. Zero data retention (below) disables xAI's
  session resumption.

Not accepted: a `tools` array, or any entry of type `mcp`, `web_search`,
`x_search` or `file_search`. xAI's server-side tools run outside the
platform's tool logging, access control and outbound filters, so the agent
is rejected when it is saved, and the worker strips `tools` from the merged
block as a second line.

### Reserved function names

xAI reserves `web_search`, `browse_page`, `x_keyword_search`,
`x_semantic_search`, `x_user_search`, `x_thread_fetch`, `collections_search`
and `file_search` for its server-side tools. A function with one of those
names on a Grok voice row is rejected when the agent is saved. The collision
only bites when the matching server tool is enabled, which the platform never
does, so this is a guard against a confusing failure rather than a live one.

## The text models

`text:xai/<model>` rows work like every other text provider: tool calling,
streaming, MCP servers through the client-side bridge, and automatic prompt
caching, whose cached tokens are metered as `cache_read_tokens`.

- `options.effort` maps to `reasoning_effort`. `grok-4.3` takes `none`,
  `low`, `medium`, `high` and `xhigh`; `grok-4.6` takes `low` to `xhigh`, so
  `none` is sent as `low`; the two `grok-4.20-0309` models take no effort
  parameter, so it is omitted. The platform's `max` is sent as `xhigh`.
- `options.temperature` is forwarded on `grok-4.20-0309-non-reasoning` only.
- `options.maxTokens` is the output cap.

The pipeline rows use the same models as the LLM stage of a Pipecat pipeline
agent, with `options.stt` and `options.tts` picking the other stages as
usual.

## Usage and billing

The voice row is billed per minute of audio, like Ultravox and GPT-Live. The
minutes land on the call's `voice` row and are priced by the model's minute
line (`model:pipecat:xai/grok-voice-think-fast-2.0` in the rate-component
catalogue). The worker also records the token counts the model reports as
`llm` rows; no line prices them, so they cost nothing and stay as usage
detail.

The text models are token-billed on `input_tokens`, `output_tokens` and
`cache_read_tokens` lines. `scripts/add-xai-rate-lines.mjs` seeds the voice
minute line, at the price of the card's Ultravox minute line, and the text
lines on the default card and on every bespoke card that prices models. It
also seeds a zero `tts` minute line for each realtime provider whose model
speaks with its own voice (`ultravox`, `openai`, `xai`), so the speech the
worker meters settles as included rather than "not priced" (see
[realtime-external-tts.md](realtime-external-tts.md)).

## Data retention and residency

Zero data retention is on for the platform's xAI account: xAI keeps no API
data and disables its own request logging and the stateful features
(session resumption, hosted files). Nothing the platform uses depends on
those. The API endpoint is global; xAI offers no EU endpoint, and its only
regional endpoint serves one text model and excludes voice.

## Limits and caveats

- Concurrent voice sessions are limited per xAI spend tier (10 on tier 0,
  rising with cumulative spend). Over the limit a session is refused at
  connect and the call takes the platform's fallback path like any provider
  failure. The Pipecat worker's own concurrency limits are the control.
- Instructions and tools can change mid-call (the in-place handover uses
  that), but the model and the voice cannot.
- `greeting.text` cannot be interrupted, by design. Keep it short.
- The Pipecat worker's `XAI_API_KEY` (or `GROK_API_KEY`) must be set, or the
  call fails at session start.
