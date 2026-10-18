# Release 0.9.59 (draft) - GPT-Live on LiveKit

> Draft. Covers changes merged to `next` since the 0.9.58 release point. The
> version number is provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## GPT-Live on LiveKit - core+livekit

- **[core+livekit] `livekit:openai/gpt-live-1`**: OpenAI GPT-Live now runs on
  the LiveKit worker, with the same `delegate` backend, voices, greeting and
  billing as the Pipecat row. It has no MCP tools, and keypad digits go to the
  voice model only. See [gpt-live.md](../gpt-live.md).
- **[livekit] Custom voices**: an organisation's custom voices
  ([custom-voices.md](../custom-voices.md)) work on the LiveKit row too. The
  same voice serves both rows, and its `models` now lists both.
