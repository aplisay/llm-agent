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

## Agents and models - pipecat

- **[pipecat] OpenAI Realtime mid-call prompts**: on `pipecat:openai/gpt-realtime`
  the inactivity prompt, keypad digits and the opening line of an in-place
  `transfer_agent` handover now reach the model. They were dropped after the
  first reply, and with `options.inactivity.hangup` set the call could end
  after three prompts the caller never heard. The handover now starts a fresh
  model conversation, so `includeHistory: false` is honoured, and a keypad
  press counts as an answer to the inactivity prompt.

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
- **[pipecat] Gemini Live transcript**: each caller turn is now one `user`
  transcript row, with interim rows while the caller speaks, as on the other
  models. Each sentence was recorded as a turn of its own.
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

## Decision models - core

- **[core] TypeSafe Jev**: `text:typesafe/jev-1.13.0`, a `decision`-kind text
  model. A decision agent's one builtin `result` function is its question set:
  an `enum` property is a Choice, a `boolean` is a Noul (probability of yes),
  and a string with `x-levels` is a Score. `POST /agents/{id}/invoke` and the
  `subagent` builtin return the typed answers with `confidence`,
  `probabilities` and, per Score, the expected value in `score`. Pinned id
  only; `jev-latest` is refused at save.
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
  line at 0.035 micros (1e-6 GBP) per token and a zero output line to existing
  cards.
- **[core] Documentation**: new [typesafe-jev.md](../typesafe-jev.md).

## Call hooks and invocation - core

- **[core] Call hook payload** carries `organisationId`, `parentId` and
  `modelName` on `start` and `end` events, from the call record. `parentId`
  is `null` on a root call; a telephony bridged human leg reports
  `modelName: "telephony:bridged-call"`. Additive; the hash is unchanged and
  does not cover them.
- **[core] `analysisService` role**: `agent:invoke` and the cross-tenant
  `agent:readAll`, nothing else, with a model list of `text:typesafe/` only,
  for a server-to-server credential that analyses calls with no user session.
  `scripts/provision-analysis-service.mjs` mints it as
  `LLM_AGENT_ANALYSIS_TOKEN` and rotates it on a re-run. `agent:readAll` joins
  the agent vocabulary; no role for a person holds it.
- **[core] `POST /agents/{id}/invoke` `callId`**: accepted from any principal,
  must be a call in the organisation the usage is charged to, and is stamped
  on the invocation's usage rows so the spend shows in `GET /usage?callId=`.
  The rows are priced when the invocation runs, not at the call's start.
- **[core] `POST /agents/{id}/invoke` `organisationId`**: accepted only from a
  principal with no organisation that holds `agent:readAll`. The agent is
  looked up in that organisation, which must be active and not billing
  blocked; its model allow-list applies, and the usage is attributed to it
  with no user. A principal with an organisation gets 400.
- **[core] `POST /agents/{id}/invoke` metering** records a run that outlives
  `SUBAGENT_TIMEOUT` when it ends, instead of dropping its tokens.
- **[core] Documentation**: [call-hooks.md](../call-hooks.md) gains the fields
  and the service-key section.

## Upgrade notes

- **[core] Database schema** stays at v66.
- **[core] Analysis service key**: a receiver that analyses calls needs a key
  from `scripts/provision-analysis-service.mjs` in each environment.
- **[core] Gemini Live rate lines**: run `scripts/add-gemini-live-rate-lines.mjs`
  against each environment, or Gemini Live usage settles `no_line`. It adds
  the three token lines for `google/gemini-2.5-flash-native-audio-preview-12-2025`
  at Google's audio list prices scaled by the card's factor (the header
  documents the overrides). Existing `gemini-2.0-flash-exp` lines are left
  in place.
- **[core+livekit+pipecat] New environment**: `NEUPHONIC_API_KEY`.
- **[core] New environment**: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
  `TYPESAFE_TIMEOUT_MS`. The Jev row is not advertised without a usable key.
- **[core] Jev rate lines**: run `scripts/add-typesafe-rate-lines.mjs` against
  each environment that advertises the row, or `typesafe` usage settles
  `no_line`.
- **[core] Neuphonic rate lines**: run `scripts/add-neuphonic-rate-lines.mjs`
  against each environment, or Neuphonic usage settles `no_line`. It copies each
  card's Cartesia character price unless `NEUPHONIC_CHARACTER_PRICE_MICROS` is set.
