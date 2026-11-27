# Billing calls from usage records

How to read the rows in `usage_records`, how the rating engine prices them
against a rate card, and what a customer should be charged for common call
types. Phone system (PBX) calls are not covered.

Feature pages describe their own meters in more detail:
[auxiliary-stt.md](auxiliary-stt.md#billing) (side STT engines),
[gpt-live.md](gpt-live.md#usage-and-billing),
[realtime-external-tts.md](realtime-external-tts.md#metering-the-models-own-speech)
(speech a realtime model makes with its own voice),
[grok.md](grok.md#usage-and-billing),
[elevenlabs-agents.md](elevenlabs-agents.md#usage-and-billing) and
[outbound-call-authorisation.md](outbound-call-authorisation.md) (destination
charges on the platform's own trunks). The design history is in
[implementation/rate-cards-implementation-plan.md](implementation/rate-cards-implementation-plan.md).

## Who can call which route

A customer reads their usage, costs, rate card and balance with
`usage:read`. Every organisation role (`owner`, `member`, `orgAdmin`) holds
it, so a customer's existing key is enough. The usage and balance routes
show only the caller's own organisation, unless the caller holds
`usage:readAll`. `GET /api/me/rates` always shows the caller's own.

The rate card routes need `rate:read`, which only the platform operator
holds (`superAdmin`, and the `billingService` machine role). The cards are
not scoped to an organisation: `GET /api/rates` lists every organisation's
card. Do not grant `rate:read` to a customer. A customer key that calls one
of these routes gets `403` with `"detail": "Requires rate:read"`. Send the
customer to `GET /api/me/rates` instead.

| Route | Needs | Who |
|---|---|---|
| `GET /api/usage`, `GET /api/usage/records` | `usage:read` | Customer |
| `GET /api/me/rates` | `usage:read` | Customer |
| `GET /api/organisations/{id}/balance` | `usage:read` | Customer |
| `GET /api/rates`, `GET /api/rates/{id}`, `GET /api/rates/default`, `GET /api/rate-components` | `rate:read` | Operator |
| `POST /api/rates`, `PATCH`/`DELETE /api/rates/{id}`, `PUT /api/rates/default` | `rate:create`, `rate:update`, `rate:delete` | Operator |
| `POST /api/agent-db/sweep` | The shared token | Internal |

## How charging works

1. **Metering.** Each thing a call uses is one row: one row per call leg (or
   text session) per agent, `technology`, `provider`, `detail` and `unit`.
   The workers post running totals during the call, so a row's `quantity`
   grows in place until the row is `finalised`.
2. **Rating.** When a row is finalised, the engine prices it and writes the
   price onto the row (`costMicros`, `rateName`, `rateCardStart`,
   `costStatus` and a per-line breakdown). A later change to the card does
   not move the price, because a card that any costed row refers to cannot be
   edited: a price change is a new version of the card with a later
   `startDate`.
3. **Settling.** If the organisation's balance is tracked, the row's cost is
   taken off it. A row that is costed again only moves the balance by the
   difference.

**Money.** `priceMicros` and `costMicros` are in micros of a pound: 1 micro
is £0.000001, and **10,000 micros is 1p**. (Some code comments and scripts
call this unit "micro-pence". That name is wrong.) The engine is GBP only. VAT
is not added.

**Which card.** The billing instant (`billedAt`) of a call row is the start
of the call leg, so a call that runs across a price change is priced on the
card in force when it started. The engine reads the user's `rateHistory`
first, then the organisation's, and takes the entry with the latest
`startDate` at or before `billedAt`. That gives a card name. It then takes
the version of that card with the latest `startDate` at or before `billedAt`
(and no `endDate` before it). A new organisation gets the platform default
card name (`GET`/`PUT /api/rates/default`, operator only) if one is set.

## Reading a row

| Field | Meaning |
|---|---|
| `sessionId` | The call leg id for voice. A generated id for a text session. |
| `callId` | The call leg the row belongs to. One leg is one `calls` row. |
| `agentId` | The agent whose usage this is. A subagent's rows carry the subagent's id. |
| `technology` | `voice`, `llm`, `tts`, `stt`, `stt-aux` or `stt-output`. |
| `provider` | For `voice`, the runtime (for example `livekit` or `pipecat`). Otherwise the vendor. |
| `detail` | For `voice`, the call's model name, for example `livekit:ultravox/ultravox-v0.6`. For `llm`, the model. For the speech rows, the model or voice that ran: see [`detail` on speech rows](#detail-on-speech-rows). |
| `unit` | `milliseconds`, `characters`, `input_tokens`, `output_tokens`, `cache_read_tokens` or `cache_write_tokens`. |
| `media` | `voice` rows only: `telephony` or `webrtc`, from the leg's own caller and called ids. A bridged leg is always `telephony`. |
| `quantity` | The total, in `unit`. |
| `finalised` | `true` once the total is complete. Only finalised rows are priced. |
| `billedAt` | The instant used to choose the card. Set at the latest when the row is costed. |
| `costMicros` | The frozen price. `null` means not priced, which is not the same as 0. |
| `costStatus` | `matched`, `no_line`, `no_rate`, `errored`, or `null` (never costed). |

The rows a call can have:

| `technology` | `unit` | Written by | One per |
|---|---|---|---|
| `voice` | `milliseconds` | The API server when the leg ends (`Call.end`). `quantity` is the leg's duration. | Call leg |
| `llm` | the four token units | The worker (model metrics), the subagent endpoint, text chat, or `POST /api/agents/{id}/invoke` | Model, per unit that is not zero |
| `tts` | `characters` and `milliseconds` | The worker | TTS engine |
| `stt` | `milliseconds` and `characters` | The worker | STT engine |
| `stt-aux`, `stt-output` | `milliseconds` and `characters` | The worker, when `options.stt.aux` or `options.tts.output` is set | Side engine |

`llm` `input_tokens` are the tokens that were not read from or written to the
prompt cache. Cached tokens are on their own rows, so each token is counted
once.

### `detail` on speech rows

A `tts`, `stt`, `stt-aux` or `stt-output` row names the model that ran, so a
line can price it by its exact `detail`. The value is what the worker built
the engine with, not what the agent asked for. Rows written before this rule
keep their old `detail`.

Pipecat worker:

| Rows | `detail` | Examples |
|---|---|---|
| `stt`, `stt-aux`, `stt-output` | `vendor/model`. A plain vendor runs the Pipecat default model. A scoped vendor (`deepgram/nova-2`) runs that model. | `deepgram/nova-3-general`, `deepgram/nova-2`, `google/latest_long` |
| `tts`, Cartesia or ElevenLabs | The model. | `sonic-3.6`, `eleven_flash_v2_5` |
| `tts`, Deepgram | The voice, which is the Deepgram model. No voice set: `aura-asteria-en`. | `aura-asteria-en`, `aura-2-thalia-en` |
| `tts`, Neuphonic | The voice id. No voice set: `neuphonic`. | |
| `tts`, a realtime model's own speech (`ultravox`, `openai`, `xai`) | The configured voice, or none. | `Mark` |

LiveKit worker (always `vendor/model`):

| Rows | `detail` | Examples |
|---|---|---|
| `stt`, `stt-aux`, `stt-output` | The STT model. Deepgram with language `multi` adds `-multilingual`, because Deepgram prices it apart. | `deepgram/nova-3`, `deepgram/nova-3-multilingual`, `assemblyai/universal-streaming`, `cartesia/ink-whisper` |
| `tts` on LiveKit Inference | The Inference model. | `cartesia/sonic-3`, `elevenlabs/eleven_turbo_v2_5`, `deepgram/aura-2` |
| `tts` on the worker's own key (`LIVEKIT_PIPELINE_USE_PROVIDER_KEYS`) | The model the plugin is given, which `LIVEKIT_PIPELINE_ELEVENLABS_MODEL` or `LIVEKIT_PIPELINE_CARTESIA_TTS_MODEL` can change. Deepgram: `deepgram/aura-2` for an Aura-2 voice, else the Aura-1 model, which is the voice. | `elevenlabs/eleven_flash_v2_5`, `cartesia/sonic-3`, `deepgram/aura-asteria-en` |
| `tts`, Google (Gemini TTS) | The Gemini TTS model (`LIVEKIT_PIPELINE_GEMINI_TTS_MODEL`). | `google/gemini-2.5-flash-preview-tts` |
| `tts`, Neuphonic | `neuphonic`. | |

The two workers do not write the same string for the same engine: a Pipecat
STT row is `deepgram/nova-3-general` and a LiveKit one is `deepgram/nova-3`.
A model default comes from the worker's SDK, so an SDK upgrade can change it.
`GET /api/usage?groupBy=technology,provider,detail,unit` shows the values your
rows carry.

## How a rate card prices a row

A card is a list of lines. Each line has a dimension (`dim`), a `match`, a
billing `unit` and a `priceMicros`:

```json
{ "dim": "audio-path", "match": { "technology": "voice", "provider": "livekit", "media": "telephony" }, "unit": "minute", "priceMicros": 60000 }
```

- **Match.** A line matches a row if every key in its `match` equals the
  row's field. A key that is left out matches anything. The keys are
  `technology`, `provider`, `detail`, `unit` and `media`.
- **One line per dimension.** The dimensions are `audio-path`, `model`,
  `tts`, `stt`, `destination`, and for the phone system `extension`,
  `recording` and `transcription`. In each dimension the engine uses the
  matching line with the most keys. If two lines have the same number of
  keys, the one that comes first on the card wins.
- **Dimensions add up.** A row's cost is the sum over the dimensions that
  matched. This is how one `voice` row is charged both for the audio path
  (runtime and media) and for a per-minute model (its `detail`).
- **Units.** A `minute` line rounds the row's milliseconds **up to the next
  6 seconds**, then divides by 60. Each row is rounded on its own. A `token`
  or `character` line uses the quantity as it is, with no conversion.
- **Minimum.** A `minute` line may set `minimumSeconds`. A row with a
  non-zero duration is then billed at least that long, and in 6-second steps
  above it. A row with zero duration still costs nothing. With
  `"minimumSeconds": 60`, a 20 second row bills 1 minute and a 61 second row
  bills 1.1 minutes. The minimum is per line and per row: a line without
  the field has no minimum, and each row gets its own minimum. A call leg
  that moves to another agent has one row per agent, so each of those rows
  is billed at least the minimum. The breakdown entry for the line shows
  `minimumSeconds` and `minimumApplied`. The field is rejected on any other
  unit and on `destination` lines, which have the tariff's own minimum.
- **Results.** At least one dimension matched: `matched`. A card was found
  but no line matched: `no_line`, cost `null`. No card name or no card
  version covers `billedAt`: `no_rate`, cost `null`. An error: `errored`.

Three rules that are easy to miss:

- **A TTS or STT line must name the row unit** (`"unit": "characters"` or
  `"unit": "milliseconds"` in `match`). The workers write both units for an
  engine. A character line with no `match.unit` also matches the
  `milliseconds` row and charges each millisecond as a character.
- **A TTS or STT line with no `detail` prices every model of that vendor.**
  Two models of one vendor can cost different amounts. Name `detail` in
  `match` to price one model. A model with no line then stays `no_line`,
  which is easier to see than a wrong price.
- **A model's token lines must match the `detail` the row carries.** The
  voice workers write `vendor/model` (`openai/gpt-4o-mini`). Text agents and
  subagents write the bare model id (`claude-haiku-4-5`). A model used both
  ways needs lines for both forms.

`GET /api/rate-components` (operator only) lists a match template for each
priceable component. Its `tts` and `stt` templates do not include `unit`, so
add it when you build a line.

**Destination.** A leg carried out on one of the platform's own trunks
(`Trunk.chargeable`) has the dialled number on its `voice` row
(`metadata.destinationRaw`). The card's `destination` line names a tariff. The engine finds the longest matching prefix and adds
`callStart + max(minimum, connect + perMinute × minutes)` to the row, with
the peak or off-peak rate chosen by the call's start time and the duration
rounded up to the tariff's increment (6 seconds by default). Inbound legs,
WebRTC legs, REFER transfers and trunks the customer brings are not charged
this way. See
[outbound-call-authorisation.md](outbound-call-authorisation.md).

## Getting the numbers out

A customer key can call the four routes below. The sweep at the end of this
section is internal. See [Who can call which route](#who-can-call-which-route).

- `GET /api/usage` gives totals. Group with `groupBy` (for example
  `technology,provider,detail,unit` or `call`), bucket with
  `period=day|week|month`, and pass `finalised=true` for settled rows only.
  Each group has `costMicros` (the sum, or `null` if no row in it is priced),
  `uncostedMeters`, `costedQuantity`, `provisionalMeters` and
  `zeroRatedMeters`.
- `GET /api/usage/records` gives the rows themselves, newest first, with
  `costBreakdown` and a `priceState`: `priced`, `included` (priced at 0),
  `provisional` (not finalised yet), `no_line`, `no_rate`, `errored` or
  `uncosted` (finalised but never costed). Filter by `callId`, `technology`,
  `costStatus`, `priced=true|false` and others.
- Both are scoped to the caller's organisation. A `usage:readAll` holder sees
  every organisation.
- `GET /api/me/rates` gives the card in force now for the caller's own
  organisation: its `name`, `startDate` and `lines`, in the same form as
  above. If no card is in force it returns `rated: false` and a `reason`.
  The usage is then metered but not charged.
- `GET /api/organisations/{id}/balance` gives the balance in pence.

For an invoice period, filter `/api/usage/records` by `startDate` and
`endDate`, or use the `period` buckets of `/api/usage`. Both use `billedAt`
(falling back to `created_at`). The `startDate` and `endDate` filters of
`/api/usage` use `created_at` only.

Before you invoice, check that `uncostedMeters` and `provisionalMeters` are 0,
or that you know why not. Convert to pence by dividing `costMicros` by
10,000.

**Pricing a row again.** The sweep (`POST /api/agent-db/sweep`, internal,
`dryRun: true` first) prices finalised rows that have no price yet
(`no_line`, `no_rate`, `errored` or never costed). It first finalises meters
that have not changed for 24 hours (`USAGE_STALE_SESSION_HOURS`). Rows that
are already `matched` are never priced again. To price a `no_line` row, add
the missing line in a new version of the card that starts after the version
that left it unpriced and at or before the row's `billedAt`, then run the
sweep. Nothing in this repository runs the sweep on a schedule.

## The example card

All the examples use this card. The prices are only examples. Where the
table does not show `technology`, it is `voice` on audio-path lines and `tts`
on tts lines.

| Dim | Match | Unit | Price (micros) |
|---|---|---|---|
| audio-path | `detail: telephony:bridged-call`, `media: telephony` (**first on the card**) | minute | 20,000 |
| audio-path | `provider: livekit`, `media: telephony` | minute | 60,000 |
| audio-path | `provider: livekit`, `media: webrtc` | minute | 40,000 |
| audio-path | `provider: pipecat`, `media: telephony` | minute | 60,000 |
| audio-path | `provider: pipecat`, `media: webrtc` | minute | 40,000 |
| model | `technology: voice`, `detail: livekit:ultravox/ultravox-v0.6` | minute | 90,000 |
| model | `technology: voice`, `detail: pipecat:ultravox/ultravox-v0.6` | minute | 90,000 |
| model | `technology: voice`, `detail: pipecat:openai/gpt-live-1` | minute | 100,000 |
| model | `technology: llm`, `provider: openai`, `detail: openai/gpt-5.6-luna`, `unit`: each token unit | token | input 0.22, output 1.4, cache read 0.022, cache write 0.28 |
| model | `technology: llm`, `provider: anthropic`, `detail: claude-haiku-4-5`, `unit`: each token unit | token | input 1.1, output 5.5 |
| model | `technology: llm`, `provider: openai`, `detail: openai/gpt-4o-mini`, `unit`: each token unit | token | input 0.17, output 0.66 |
| tts | `provider: ultravox`, `unit: milliseconds` | minute | 0 |
| tts | `provider: elevenlabs`, `unit: characters` | character | 110 |
| tts | `provider: elevenlabs`, `unit: milliseconds` | minute | 0 |
| stt | `technology: stt`, `provider: assemblyai`, `unit: milliseconds` | minute | 8,300 |
| stt | `technology: stt`, `provider: deepgram`, `unit: milliseconds` | minute | 11,000 |
| stt | `technology: stt-aux`, `provider: deepgram`, `unit: milliseconds` | minute | 11,000 |
| stt | `technology: stt-output`, `provider: deepgram`, `unit: milliseconds` | minute | 11,000 |
| stt | each of the four `stt` lines above with `unit: characters` | character | 0 |

## 1. An all-inclusive per-minute call (Ultravox)

A per-minute model (Ultravox, GPT-Live, the Grok voice model, ElevenLabs
Agents) is charged on the call's `voice` row. For Ultravox, LiveKit writes no
other row. Pipecat also writes the model's own speech as `tts` milliseconds
under `ultravox`, which the card prices at 0 so it shows as included.

LiveKit, phone call of 20.775 s (24 s after rounding, 0.4 min):

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` `livekit` `livekit:ultravox/ultravox-v0.6` `telephony` | 20,775 ms | audio-path 0.4 × 60,000, model 0.4 × 90,000 | 60,000 |

Total 60,000 micros, 6p.

Pipecat, browser call of 54.874 s (60 s, 1.0 min):

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` `pipecat` `pipecat:ultravox/ultravox-v0.6` `webrtc` | 54,874 ms | audio-path 1.0 × 40,000, model 1.0 × 90,000 | 130,000 |
| `tts` `ultravox` `Louisamay` `milliseconds` | 31,020 ms | tts 0.6 × 0 | 0 (included) |

Total 130,000 micros, 13p.

## 2. Transfers

Each leg of a transferred call is its own `calls` row, linked by `parentId`,
with its own `voice` row. Each leg is charged on its own lines. Find all the
legs of a call with `GET /api/calls/{id}/linked`, then read each leg's rows.

**Blind transfer, bridged (LiveKit).** The agent's leg ends when the bridge
starts. The rest of the call is a new leg with the model name
`telephony:bridged-call`, priced on the bridged-call line only.

| Leg | Row | Quantity | Lines | Cost |
|---|---|---|---|---|
| Agent | `voice` `livekit:ultravox/ultravox-v0.6` `telephony` | 20,775 ms | 0.4 × (60,000 + 90,000) | 60,000 |
| Bridged | `voice` `livekit` `telephony:bridged-call` `telephony` | 12,855 ms | audio-path 0.3 × 20,000 | 6,000 |

Total 66,000 micros. The bridged row matches both the bridged-call line and
the `livekit` `telephony` line, with three keys each, so card order decides.
Put the bridged-call line first. In the other order this leg costs 18,000.

**Blind transfer by SIP REFER.** The caller's end makes the new call, and the
platform drops out. There is only the agent's leg, up to the REFER: for
30 s, 0.5 × (60,000 + 90,000) = 75,000.

**Consultative transfer, then bridged (LiveKit).** The agent calls the
target on a consult leg while the caller holds. The consult leg has the same
model name as the agent and is priced like it. The caller's leg runs at the
same time, so both are charged for the overlap. When the target accepts,
both end and a bridged leg carries the rest.

| Leg | Quantity | Lines | Cost |
|---|---|---|---|
| Agent (caller's leg) | 47,682 ms | 0.8 × (60,000 + 90,000) | 120,000 |
| Consult | 25,757 ms | 0.5 × (60,000 + 90,000) | 75,000 |
| Bridged | 12,469 ms | 0.3 × 20,000 | 6,000 |

Total 201,000 micros. A consultative transfer that completes by REFER has the
first two legs and no bridged leg.

**Pipecat, browser caller.** The worker relays the caller's browser audio to
the target. As on LiveKit, the agent leaves when the bridge starts: the
worker closes the model session and ends the agent's leg, and the bridged
leg carries the rest. The bridged leg starts when the worker dials the
target, so the ring time is on both legs.

| Leg | Quantity | Lines | Cost |
|---|---|---|---|
| Agent | 12,459 ms | 0.3 × (40,000 + 90,000) | 39,000 |
| Bridged | 53,487 ms | 0.9 × 20,000 | 18,000 |

Total 57,000 micros. A consultative transfer from a browser caller has the
same three legs as the LiveKit one above: the agent's leg and the consult leg
both end when the target accepts.

On Pipecat a consult leg also carries its own component rows, as the agent's
leg does (for Ultravox with side STT: `tts`, `stt-aux` and `stt-output`). On
LiveKit an Ultravox consult leg has only its `voice` row. A bridged or
consult leg that goes out on a chargeable platform trunk also has a
destination charge on its `voice` row.

## 3. Optional features (side STT, recording)

**Side STT engines.** `options.stt.aux` adds `stt-aux` rows and
`options.tts.output` adds `stt-output` rows, in milliseconds and characters,
on every voice mode. A line on `technology: stt` does not match them: they
need their own lines, or they stay `no_line`. LiveKit phone call of 20.775 s
with both:

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` (as in example 1) | 20,775 ms | 0.4 × (60,000 + 90,000) | 60,000 |
| `stt-aux` `deepgram` `milliseconds` | 6,600 ms | 0.2 × 11,000 | 2,200 |
| `stt-aux` `deepgram` `characters` | 70 | 70 × 0 | 0 |
| `stt-output` `deepgram` `milliseconds` | 3,645 ms | 0.1 × 11,000 | 1,100 |
| `stt-output` `deepgram` `characters` | 63 | 63 × 0 | 0 |

Total 63,300 micros.

**Recording.** Recording writes no usage row, and neither does downloading a
recording (downloads are logged in `call_recording_downloads`, which the
engine does not read). The rating engine cannot charge for recording. Bill it
outside the engine if you charge for it.

**Text output.** A realtime model that speaks through an external TTS writes
`tts` rows under that TTS vendor, priced by that vendor's lines, on top of
the model's own charge.

## 4. GPT-Live with delegation

GPT-Live is per minute on its `voice` row, like Ultravox, so the card needs a
`model` line for each GPT-Live model name. The backend text model is charged
per token on `llm` rows. How those rows arrive depends on the delegate's
model.

**OpenAI-hosted delegation** (a `text:openai/*` delegate, or no delegate,
which runs the backend on `openai/gpt-5.6-luna`).
The worker writes the backend's tokens as `llm` rows on the same call leg,
under the voice agent, and finalises them with the call. Pipecat browser call
of 32.452 s (36 s, 0.6 min):

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` `pipecat` `pipecat:openai/gpt-live-1` `webrtc` | 32,452 ms | 0.6 × (40,000 + 100,000) | 84,000 |
| `llm` `openai` `openai/gpt-5.6-luna` `cache_read_tokens` | 2,508 | × 0.022 | 55 |
| `llm` `openai` `openai/gpt-5.6-luna` `cache_write_tokens` | 1,673 | × 0.28 | 468 |
| `llm` `openai` `openai/gpt-5.6-luna` `input_tokens` | 135 | × 0.22 | 30 |
| `llm` `openai` `openai/gpt-5.6-luna` `output_tokens` | 169 | × 1.4 | 237 |

Total 84,790 micros. Each line's cost is rounded to a whole micro.

**Client delegation** (any other text model, for example
`text:anthropic/claude-haiku-4-5`). Each delegation is a subagent call
through the platform's subagent endpoint. Its tokens are written as `llm`
rows on the call (same `sessionId` and `callId`), under the delegate's
`agentId`, with the bare model id as `detail`. Each delegation adds to the
rows. For 3,000 input and 250 output tokens:

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` (as above) | 32,452 ms | 0.6 × (40,000 + 100,000) | 84,000 |
| `llm` `anthropic` `claude-haiku-4-5` `input_tokens` | 3,000 | × 1.1 | 3,300 |
| `llm` `anthropic` `claude-haiku-4-5` `output_tokens` | 250 | × 5.5 | 1,375 |

These rows are finalised when the call ends and priced on the card in force
at the call's start. The same applies to a `subagent` function called from
any voice agent.

## 5. Pipeline agents (STT, LLM, TTS)

A pipeline agent's `voice` row has no per-minute model line, so only the
audio path prices it. This card prices the LLM per token, the TTS per
character and the STT per minute, and the other unit of each engine at 0.
LiveKit browser call of 60.79 s (66 s, 1.1 min):

| Row | Quantity | Lines | Cost |
|---|---|---|---|
| `voice` `livekit` `livekit:openai/gpt-4o-mini` `webrtc` | 60,790 ms | audio-path 1.1 × 40,000 | 44,000 |
| `llm` `openai` `openai/gpt-4o-mini` `input_tokens` | 1,547 | × 0.17 | 263 |
| `llm` `openai` `openai/gpt-4o-mini` `output_tokens` | 130 | × 0.66 | 86 |
| `stt` `assemblyai` `milliseconds` | 51,200 ms | 0.9 × 8,300 | 7,470 |
| `stt` `assemblyai` `characters` | 158 | × 0 | 0 |
| `tts` `elevenlabs` `characters` | 529 | × 110 | 58,190 |
| `tts` `elevenlabs` `milliseconds` | 30,266 ms | 0.6 × 0 | 0 |

Total 110,009 micros, about 11p.

A Pipecat pipeline call has the same rows. Its `stt` `milliseconds` row is
all the caller audio sent to the STT engine, silence included, so it is
close to the call length. On LiveKit the row is the audio the STT plugin
reports sending. LiveKit Inference sends all of it. The Deepgram plugin,
used when `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` is set, does not send quiet
audio, so its row can be much shorter than the call.

## The phone system

An organisation with the phone system is charged for three things beside its
agents: a monthly charge for each extension, its outside legs, and recording
and transcription where they are used. All of them are usage rows, priced by
the organisation's rate card and drawn from its credit balance.

**When it starts.** None of this acts until `tools/agent-admin.js upgrade-db`
has brought the database to schema 79 and the API server has restarted: no
charge, no usage for phone system calls, no refusal on an empty balance. The
first upgrade to schema 79 writes the instant it ran into the `metadata`
table (key `extensionChargeStartedAt`), once. No day before that day is ever
charged.

**The first upgrade to schema 79, in this order:**

1. Give each rate card that should charge for extensions an `extension` line
   (below). A month whose charge finds no line is closed at nothing and never
   charged, so without the line the rest of the first month is free.
2. Flag every platform trunk that phone system calls leave by `chargeable`
   (below). `yarn doctor` lists those that are not. A leg on a trunk that is
   not flagged goes out with no charge and no policy, and is logged.
3. Run `tools/agent-admin.js upgrade-db` ([upgrading](self-hosting/upgrading.md#the-database-schema-step)).
4. Restart the API server.

**Every call writes usage.** When call control ends a phone system call or an
answered leg, llm-agent writes a row for it (`technology: pbx`, `provider:
pbx`, `detail` the call's model name, `unit: milliseconds`). A leg out to an
outside number on a trunk flagged `chargeable` carries the destination charge
from the card's `destination` line, as an agent's outside leg does. Every
other row, a call between extensions, a call in, or a leg on a trunk that is
not flagged, is written at nothing: `costMicros` 0 and `costStatus` `free`.
`GET /usage/records` shows those as `priceState: free`.

**Platform trunks must be flagged.** A phone system leg is charged, and passes
the organisation's outbound policy, only on a trunk flagged `chargeable`
(`PUT /trunks/{id}` with `"chargeable": true`). On each environment, flag every
trunk that carries calls to a carrier we pay, and leave a customer's own trunk
and every registration unflagged. Flagging a trunk applies to agents too:
their legs on it then need a destination tariff and are charged for it.
`yarn doctor` lists every trunk that phone system numbers use, or that
`APLISAY_OUTBOUND_TRUNK_ID` names, which is not flagged and is not a
registration. The server logs the same list when it starts, and a warning for
each phone system leg placed on such a trunk.

**Only its own lines price it.** A phone system row (`pbx`, `extension`,
`recording`, `transcription`) is priced only by a line whose `match` names
that technology. A line written for agent calls by its media, provider or
unit alone, such as `{ "media": "telephony" }`, never prices one. A line of
the `extension`, `recording` or `transcription` dimension must name its own
technology, and prices nothing else. To add a charge by the minute on
outside legs, add a line that matches `technology: pbx`.

**The monthly charge for each extension.** Once an hour, and at each start,
the server charges every live extension of an organisation with the phone
system for the current calendar month (UK time), except extensions of type
`connection`, which are free. The charge runs from the latest of the first of
the month, the day the extension was created and the day charging started, by
the day. The row is `technology: extension`, `provider: pbx`, `detail` the
extension's type, `unit: day`, with the number of days, and it is priced by a
line such as:

```json
{ "dim": "extension", "match": { "technology": "extension" }, "unit": "month", "priceMicros": 4000000 }
```

A `month` line divides the days by the length of that month: 20 days of a
30-day month at £4 is £2.666667. A line may match `detail` to give one type of
extension its own price.

- **Billing instant.** The rate card is the one in force at noon UTC on the
  first day charged, which is inside that UK day all year. When the extension
  was created, or charging started, later that day, it is that moment
  instead. A card version dated the first of a month prices that month.
- **Once.** Each extension has one row a month, so the charge runs as often as
  it likes, on as many servers as there are, and charges once. A run that
  finds a row without a cost (a run that stopped half way) costs it.
- **No price.** A charge the card cannot price (no `extension` line, or no
  card) is closed at nothing: `costMicros` 0, `costStatus` `unpriced`, with
  `metadata.unpricedBecause`. A card added later does not price a past month.
  To start charging from a month, give the card an `extension` line from that
  month on.
- **In advance.** An extension removed during a month is not refunded, and one
  created and removed between two runs is not charged.
- **Organisation status.** A deactivated organisation (`status`
  `deactivated`) is not charged, and its phones take no calls except to 999
  and 112 ([the phone system](phone-system.md#a-deactivated-organisation)). A
  suspended one is charged as usual. A month charged before the organisation
  is deactivated keeps its charge. If it is made active again, the month it
  comes back in is charged like any other month: from the first, or from the
  day the extension was created, and nothing more if that month was already
  charged. The day it came back is not recorded, so it is not used.
- **In a write.** A directory write shows the charges it starts and stops in
  its effect (`effect.charges`), also in a dry run. Each start quotes what the
  job will charge this month, from the same day and on the same card, and
  nothing more for a month already charged. `priced` is false when the card
  has no `extension` line. A write for a deactivated organisation shows no
  charges.

**Recording and transcription.** The end of a call or leg may say how much
was transcribed (`transcribedMs`). Call control sends how long a call's
recording is (`recordedMs`) on a second end of the call, once the recording
route has stored the file ([the recording of a
call](phone-system.md#the-recording-of-a-call)). A recording that is not kept
sends nothing. Each length is held to the length of the call or leg, and a
value that is not a whole number of milliseconds is ignored. Each writes one
row (`technology: recording` or `transcription`, `unit: milliseconds`) priced
by a `recording` or `transcription` line by the minute. The first length that
writes the row stands, so the same end sent again writes nothing.

A recording row is priced only when the call holds its recording at the moment
the length arrives. A length on a leg, on a call whose recording was not
stored, or on a call that has been erased is written at nothing (`costStatus`
`free`), and a later length does not change it. Erasing a call keeps its
usage rows, so a recording charged before the erasure stays charged.

**An empty balance.** With the credit balance at zero or below, outside calls
are refused (`balance_empty`, [outbound call
authorisation](outbound-call-authorisation.md)). Calls in, calls between
extensions and emergency calls go on. When a monthly charge draws money and
leaves the balance below zero, the organisation is marked. If the balance is
still below zero 30 days later, its phones stop taking calls: call control is
told to refuse with `charge_unpaid`. Emergency calls still go out. A charge
that draws nothing never marks it. A top-up that brings the balance back to
zero or above clears the mark at once. An organisation whose balance is not
tracked is never stopped.

**Totals by brand.** `GET /usage?groupBy=brand` sums the usage of each brand's
organisations, and `?brand=` keeps one brand. A platform operator sees every
brand; anyone else sees their own organisation.

**Who sees the rows.** The usage rows of a phone system call follow the call
([who sees calls](phone-system.md#who-sees-calls)). A member sees no usage for
a call they may not see, the same answer as for a call that does not exist.

## Checklist for a rate card

- An audio-path line for each runtime and media you carry, and the
  bridged-call line before the runtime `telephony` lines.
- A `model` minute line for each per-minute model name you allow (Ultravox,
  GPT-Live, Grok voice, ElevenLabs Agents).
- Token lines for each text model, in each `detail` form your rows carry.
- `tts` and `stt` lines with `match.unit`, for both units of each engine,
  and with `match.detail` where two models of a vendor have different prices.
- `stt-aux` and `stt-output` lines if agents use side engines.
- Zero `tts` lines for `ultravox`, `openai` and `xai` (speech the model makes
  with its own voice on Pipecat).
- For the phone system: an `extension` line by the month, and `recording`
  and `transcription` lines by the minute if those are used.
- Then look for `no_line` rows: `GET /api/usage/records?costStatus=no_line`.
