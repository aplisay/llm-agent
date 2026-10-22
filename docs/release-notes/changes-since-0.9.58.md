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
