# Release 0.9.56 (draft) - Ultravox hangup fix, Neuphonic TTS

> Draft. Covers changes merged to `next` since the 0.9.55 release point
> (2 pull requests, 19 - 22 September 2026). The version number is
> provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Agents and models - livekit

- **[livekit] Ultravox hangup**: the `hangup` builtin's result now tells
  Ultravox to listen (`agentReaction: "listens"`), including after an in-place
  handover. The model no longer calls `hangup` again, and the call ends without
  a silent gap. Other tools keep Ultravox's default.
- **[livekit] Gemini TTS usage** is recorded once per reply. Agents with
  `options.tts.vendor: "google"` had each reply's `tts` characters recorded
  twice, and its milliseconds over-counted.
- **[livekit] Google TTS billing**: agents with `options.tts.vendor: "google"`
  and no `voice` now have their `tts` usage recorded under `google`. It was
  recorded under `cartesia`.
- **[livekit] Handover usage** is recorded once. After an in-place
  `transfer_agent` handover, pipeline agents recorded later `llm` tokens, `tts`
  characters and milliseconds, and `stt` milliseconds once for every agent that
  had held the call. On realtime models only an external TTS was affected.

## Gemini Live - core+livekit+pipecat

- **[core+livekit+pipecat] Gemini Live model**: the Gemini Live rows are now
  `pipecat:google/gemini-2.5-flash-native-audio-preview-12-2025` and
  `livekit:google/gemini-2.5-flash-native-audio-preview-12-2025`, labelled
  "Google Gemini 2.5 Flash Live". Google shut down `gemini-2.0-flash-exp`, the
  model the rows were named after, on 9 December 2025. Neither worker passed
  the row's id to its library, so both ran the library's default Live model,
  which is the model the rows now name. Agents saved on the old id keep working
  and run this model, and the old id stays listed as a retired alias while the
  new row is offered. Usage on the Pipecat worker is recorded under the new id.
- **[pipecat] Gemini Live voice**: `options.tts.voice` now reaches the model.
  It was ignored, and every call spoke with Pipecat's default voice (Charon).
  No language is sent: Google's Live API guide says native-audio models choose
  the language themselves, so the system prompt is the way to pin one.
- **[pipecat] Gemini Live inactivity prompt**: `options.inactivity.message` is
  now spoken on Gemini Live. The prompt reached the worker's own context but
  was never sent to the model.
- **[pipecat] Gemini Live keypad digits**: DTMF digits now reach the model, as
  a user turn it answers (`options.dtmfTimeout` and `options.dtmfTerminator`
  apply as before). They were buffered into a user message the model never
  received.
- **[pipecat] Gemini Live handover**: `transfer_agent` between two agents on the
  same Gemini Live model now restarts the agent stack, as it already did for
  Ultravox, GPT-Live and Grok. The in-place swap left the outgoing agent's
  prompt and tools in place, and the incoming agent never spoke.

## Voices - core+livekit+pipecat

- **[core+livekit+pipecat] Neuphonic TTS**: `options.tts.vendor: "neuphonic"` on
  pipeline models on both workers, on the realtime rows flagged
  `hasExternalTts`, and for `options.fallback.message`. Not available on jambonz,
  `ultravox:`, Gemini Live, Grok voice or GPT-Live.
- **[core] Neuphonic voices**: `GET /models/{modelName}/voices/{locale}` lists
  Neuphonic's stock voices under `neuphonic`, by language and accent. Without
  `voice`, Neuphonic uses its default voice for the language.
- **[core] Neuphonic billing**: `tts|neuphonic` usage, in characters and
  milliseconds, and a `tts:neuphonic` rate component.
  `scripts/add-neuphonic-rate-lines.mjs` adds the lines to existing cards.
- **[livekit+pipecat] Neuphonic leading silence** is trimmed from each sentence,
  so replies start sooner and the pauses between sentences are shorter. Silence
  inside a sentence is kept.
- **[core] Documentation**: new [neuphonic.md](../neuphonic.md).

## Transfers - pipecat

- **[pipecat] WebRTC blind transfers** record the telephony leg with
  `modelName: "telephony:bridged-call"`, as LiveKit does. The leg is no longer
  billed as voice minutes on the agent's model.
- **[pipecat] WebRTC consultative transfers** end the consultation call record
  on `accept_transfer`, and a new `telephony:bridged-call` record covers the
  rest of the leg. The whole leg was recorded on the agent's model.

## Upgrade notes

- **[core] Database schema** stays at v66.
- **[core] Gemini Live rate lines**: run `scripts/add-gemini-live-rate-lines.mjs`
  against each environment, or Gemini Live usage settles `no_line`. It adds
  the three token lines for `google/gemini-2.5-flash-native-audio-preview-12-2025`
  at Google's audio list prices scaled by the card's factor (the header
  documents the overrides). Existing `gemini-2.0-flash-exp` lines are left
  in place.
- **[core+livekit+pipecat] New environment**: `NEUPHONIC_API_KEY`.
- **[core] Neuphonic rate lines**: run `scripts/add-neuphonic-rate-lines.mjs`
  against each environment, or Neuphonic usage settles `no_line`. It copies each
  card's Cartesia character price unless `NEUPHONIC_CHARACTER_PRICE_MICROS` is set.
