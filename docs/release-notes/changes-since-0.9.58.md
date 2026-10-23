# Release 0.9.59 (draft) - GPT-Live on LiveKit

> Draft. Covers changes merged to `next` since the 0.9.58 release point. The
> version number is provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## ElevenLabs Agents on Pipecat - core+pipecat

- **[core+pipecat] `pipecat:elevenlabs/<llm>`**: ElevenLabs Agents runs on the
  Pipecat worker as four realtime rows, one per LLM (Gemini 2.5 Flash, GPT-5.4
  mini, Claude Haiku 5.5, Claude Sonnet 5.5). Functions, builtins and MCP
  tools run as client tools; the greeting text is spoken word for word; the
  voice is any ElevenLabs catalogue voice; billing is per minute on the call's
  voice row. `vendorSpecific.elevenlabs.conversation_config` tunes
  turn-taking and the TTS model. See [elevenlabs-agents.md](../elevenlabs-agents.md).
- **[core+livekit] `livekit:elevenlabs/<llm>`**: the same four rows on the
  LiveKit worker, sharing the hosted agents with the Pipecat rows.
- **[core] `scripts/add-elevenlabs-rate-lines.mjs`** seeds the minute lines;
  `scripts/prune-elevenlabs-agents.mjs` removes hosted agents no longer used.

## GPT-Live on LiveKit - core+livekit

- **[core+livekit] `livekit:openai/gpt-live-1`**: OpenAI GPT-Live now runs on
  the LiveKit worker, with the same `delegate` backend, voices, greeting and
  billing as the Pipecat row. It has no MCP tools, and keypad digits go to the
  voice model only. See [gpt-live.md](../gpt-live.md).
- **[livekit] Custom voices**: an organisation's custom voices
  ([custom-voices.md](../custom-voices.md)) work on the LiveKit row too. The
  same voice serves both rows, and its `models` now lists both.

## Gemini Live - core+livekit+pipecat

- **[core+livekit+pipecat] Gemini Live model**: the Gemini Live rows are now
  `google/gemini-2.5-flash-native-audio-preview-12-2025` ("Google Gemini 2.5
  Flash Live") on both workers. Google has shut down `gemini-2.0-flash-exp`, the
  model the rows were named after. Pipecat ran its library's default Live
  model, the one the rows now name, and LiveKit sent the retired id.
- **[core+livekit+pipecat] Retired Gemini id**: agents saved on
  `google/gemini-2.0-flash-exp` run the new model on both workers. The old id
  stays listed as a retired alias while the new row is offered. Pipecat records
  usage under the new id.
- **[pipecat] Gemini Live voice**: `options.tts.voice` now reaches the model.
  Every call spoke with Pipecat's default voice (Charon), which stays the
  default.
- **[pipecat] Gemini Live inactivity prompt**: `options.inactivity.message` is
  now spoken. The model never received it. It waits until the caller stops
  speaking.
- **[pipecat] Gemini Live keypad digits**: DTMF digits now reach the model as a
  user turn it answers. `options.dtmfTimeout` and `options.dtmfTerminator`
  apply as before.
- **[pipecat] Gemini Live transcript**: each caller turn is one `user`
  transcript row, with interim rows while the caller speaks, as on the other
  models. Each sentence was a row of its own.
- **[pipecat] Gemini Live handover**: `transfer_agent` between two agents on
  the same Gemini Live model now restarts the agent stack with a child call
  record, as for Ultravox, GPT-Live, Grok voice and ElevenLabs Agents. The
  in-place swap kept the outgoing agent's prompt and tools.

## Upgrade notes

- **[core] Gemini Live rate lines**: run `scripts/add-gemini-live-rate-lines.mjs`
  against each environment, with `--dry-run` first, before deploying the API
  and rolling the workers. It adds the token lines for
  `google/gemini-2.5-flash-native-audio-preview-12-2025` at the prices each
  card already charges for `google/gemini-2.0-flash-exp`. The new card
  versions start when it runs, so usage recorded earlier stays unpriced
  (`no_line`).
