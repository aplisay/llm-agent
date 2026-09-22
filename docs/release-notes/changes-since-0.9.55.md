# Release 0.9.56 (draft) - Ultravox hangup fix, Neuphonic TTS, TypeSafe Jev decision model

> Draft. Covers changes merged to `next` since the 0.9.55 release point
> (3 pull requests, 19 - 22 September 2026). The version number is
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

## Decision models - core

- **[core] TypeSafe Jev**: `text:typesafe/jev-1.13.0`, a `decision`-kind text
  model. A decision agent's one builtin `result` function is its question set:
  an `enum` property is a Choice, a `boolean` is a Noul (probability of yes),
  and a string with `x-levels` is a Score. `POST /agents/{id}/invoke` and the
  `subagent` builtin return the typed answers with `confidence` and
  `probabilities`. Pinned id only; `jev-latest` is refused at save.
- **[core] Decision agent rules**: no other functions, no `mcpServers`, no
  `tts`, `stt`, `greeting`, `fallback`, `inactivity` or `callHook` options;
  a free-string, `number`, `array` or `object` result property is refused
  with the fix in the message. A decision agent cannot chat, be a `delegate`
  target, or be a hand-back `summaryAgent`.
- **[core] `options.decision.minConfidence`** (0 to 1, decision models only)
  returns a Choice or Score answer below the threshold as `null` and sets
  `result.decision` to `review`, else `auto`.
- **[core] `GET /models` `kind`**: every row now carries `kind`, `generative`
  or `decision`. Model pickers for voice agents should hide `decision` rows.
- **[core] Jev routes**: `TYPESAFE_API_KEY` on the direct route, or
  `TYPESAFE_BASE_URL=https://openrouter.ai/api` with `OPENROUTER_KEY` as the
  fallback key. `TYPESAFE_TIMEOUT_MS` (default 5000) bounds one decision
  including its single retry; no fallback to a generative model.
- **[core] Jev billing**: `llm|typesafe|jev-1.13.0` usage in `input_tokens`
  and `output_tokens`. `scripts/add-typesafe-rate-lines.mjs` adds the input
  line at 3.5 micro-pence per token and a zero output line to existing cards.
- **[core] Documentation**: new [typesafe-jev.md](../typesafe-jev.md).

## Upgrade notes

- **[core] Database schema** stays at v66.
- **[core+livekit+pipecat] New environment**: `NEUPHONIC_API_KEY`.
- **[core] New environment**: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
  `TYPESAFE_TIMEOUT_MS`. The Jev row is not advertised without a usable key.
- **[core] Jev rate lines**: run `scripts/add-typesafe-rate-lines.mjs` against
  each environment that advertises the row, or `typesafe` usage settles
  `no_line`.
- **[core] Neuphonic rate lines**: run `scripts/add-neuphonic-rate-lines.mjs`
  against each environment, or Neuphonic usage settles `no_line`. It copies each
  card's Cartesia character price unless `NEUPHONIC_CHARACTER_PRICE_MICROS` is set.
