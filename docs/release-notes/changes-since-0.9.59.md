# Release 0.9.60 (draft) - brands, phone system directory, caller identity flags, speech metering

> Draft. Covers changes merged to `next` since the 0.9.59 release point
> (28 pull requests, 14 - 18 November 2026, up to #503). The version number is
> provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Brands - core

- **[core] Schema 74 required**: brands need schema 74, applied by
  `upgrade-db`. Until then the brand routes and the `brand` field on the
  organisation routes answer 503 `brands_not_ready`. Everything else works.
- **[core] Organisation brand**: an organisation gains a `brand`, set when it
  is created and fixed after. A platform operator may give a brand to an
  organisation that has none. `GET /organisations` takes `brand` as a filter.
- **[core] Brand defaults**: the new `brands` table holds the capabilities a
  new organisation of the brand starts with. `GET /brands`,
  `GET /brands/{brandId}` and `PUT /brands/{brandId}` read and set them
  (`brand:read`, `brand:update`). A change applies to later organisations.
- **[core] Brand service keys**: a service key may carry a brand. The
  `brandService` role creates organisations of its brand, sets their
  capabilities, and reads only its brand's organisations.
  `scripts/provision-brand-service.mjs` mints one key per brand.
- **[core] `GET /me`** now gives the organisation's brand and capabilities,
  and the brand a service key acts for.
- **[core] Organisation settings**: an owner may read and change its own
  organisation's phone system settings. Changing an organisation's status now
  needs `organisation:setLimits`.

## Phone system - core

- **[core] Schemas 72 and 73 required**: the phone system needs both, applied
  by `upgrade-db`. Until then its directory, phone, settings and capabilities
  routes, and call control's extension, line and call event paths, answer 503
  `phone_system_not_ready`. Calls to agents, numbers and connections work.
- **[core] Directory batch**: `POST /directory/batch` applies up to 500
  directory changes in one transaction, all or none. A later op may refer to a
  row an earlier op creates. A refused op gives 400 `batch_failed`, with a
  result for each op.
- **[core] Restore and purge**: a removed entry or extension can be restored
  for 30 days, through its `restore` route or the batch, and is then purged by
  a daily job. An entry comes back with the extension removed with it.
- **[core] Directory lookup and resolve**: `GET /directory/lookup` and
  `GET /directory/resolve` answer agent tools. An entry whose extension is one
  of ours and who has no direct number gets that extension's shown number as
  `direct`.
- **[core] Knowledge service keys**: the `knowledgeService` role reads any
  organisation's directory and writes only through the batch.
  `scripts/provision-knowledge-service.mjs` mints its key.
- **[core] Extension helpers**: `GET /directory/extensions/next-number` offers
  a free number. `GET /directory/extensions/{extensionId}/rings-now` shows what
  a call would ring now, with offline lines marked.
- **[core] Calling phone**: a ring plan no longer rings the phone that placed
  the call. It is listed in `skipped` with the reason `caller_phone`. The
  user's other phones still ring.
- **[core] Own extensions**: outbound authorisation refuses digits that are
  one of the organisation's own extension numbers, with
  `internal_extension_not_reachable`.
- **[core] Resolve route**: `POST /agent-db/pbx/resolve` answers
  `action: "agent"` for a number an agent listens on, and takes a
  `registration` request kind. New refusals: `registration_not_found`,
  `registration_not_routed`, `runtime_not_supported`, `agent_not_available`.
- **[core] Documentation**: [phone-system.md](../phone-system.md) and
  [outbound-call-authorisation.md](../outbound-call-authorisation.md) are
  updated.

## Pipecat behind call control - pipecat

- **[pipecat] Gateway scope**: this section applies to the VoiceBlender
  gateway. Production stays on sipbridge, and with `VOICEBLENDER_INBOUND`
  unset nothing changes.
- **[pipecat] `VOICEBLENDER_INBOUND`**: `events`, the default, keeps today's
  behaviour. `dispatch` leaves a ringing call to call control, which hands it
  to the worker with `POST /dispatch` and `kind: "inbound"`. Any other value
  stops the worker at start.
- **[pipecat] Call control id**: a handed-over call keeps call control's id
  as `metadata.aplisay.callControlId`.
- **[pipecat] Drain**: `POST /drain`, from the worker's own host, makes the
  worker refuse hand-overs. `python -m pipecat_aplisay.drain` is a preStop hook
  that calls it and waits up to `LIFECYCLE_DRAIN_SECONDS` for calls to end.
- **[pipecat] VoiceBlender overlay**: the Kubernetes overlay now runs. It takes
  its TLS certificate from the `pipecat-sip-tls` Secret or makes a self-signed
  one, starts the engine only when `SIP_ALLOWED_IPS` holds no `/0` range, and
  takes SIP on UDP, TCP, and TLS 5061. Its init container always pulls.
- **[pipecat] Staging target**: `do-staging` moves to the VoiceBlender overlay
  with `VOICEBLENDER_INBOUND=dispatch` and RTP on 22000-23999.
- **[pipecat] VoiceBlender keepalive**: with `SIP_GATEWAY=voiceblender` the
  worker sends no WebSocket keepalive ping, so a call no longer ends 40 s after
  the agent joins.
- **[pipecat] Blind bridged transfer** fails on the VoiceBlender gateway.
- **[core] Documentation**:
  [voiceblender-integration.md](../voiceblender-integration.md) has a new
  section, "Behind call control".

## LiveKit pipeline routing - livekit

- **[livekit] Mixed routing**: with `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` on,
  each stage goes direct when the worker has a plugin for its vendor and the
  key is set, and runs on LiveKit Inference otherwise. This covers pipeline STT,
  LLM and TTS, auxiliary and output STT, and bridged-call transcription.
- **[livekit] Former setup errors**: with provider keys on, an STT vendor other
  than Deepgram, an LLM plugin other than `google` or `openai`, a TTS with no
  direct builder, or a plugin whose key is not set now runs on Inference
  instead of failing at call setup. Neuphonic and Gemini TTS stay direct.
- **[livekit] Invocation log**: a call's log holds the agent definition once,
  not up to five times, and leaves out `options.callHook.hashKey`.

## Caller identity - livekit

- **[livekit] `sendPai` and `sendRpid`**: new trunk flags add
  `P-Asserted-Identity` and `Remote-Party-ID` with the agent's own number, as
  `"+E164" <sip:+E164@host>`. `host` is the next hop: the SBC on the outbound
  trunk, or the registration's B2BUA. Both are off by default.
- **[livekit] `useTelUriId`**: on that trunk, both headers use `tel:+E164`
  instead. The `tel:` form is also used when no host is known.
- **[livekit] `fromOriginalCaller`**: on a transfer leg, `From` carries the
  original caller instead of the agent's number.
- **[livekit] Covered legs**: the flags apply on originate, blind bridged
  transfer, and the consult dial.
- **[core] Documentation**: [phone-endpoints-api.md](../phone-endpoints-api.md)
  and [call-transfers.md](../call-transfers.md) list the flags.

## STT formatting - core+livekit+pipecat

- **[core+livekit+pipecat] `formatted`**: a new boolean in `options.stt`,
  `options.stt.aux`, and `options.tts.output` asks the engine for written form:
  digits, phone numbers, dates, money, and email addresses. Unset or `false`
  sends nothing, so existing agents are unchanged.
- **[core+livekit+pipecat] Deepgram options**: `smart_format`, `punctuate`,
  `numerals`, `no_delay`, and `endpointing` pass Deepgram's settings through.
  The API refuses them (400) in a block whose `vendor` names another engine. A
  value set in the block wins over `formatted`.
- **[livekit+pipecat] Auxiliary STT pauses**: a Deepgram side engine with
  `formatted`, or `endpointing` of 1000 ms or more, now hears the caller's
  pauses. At teardown the worker waits up to 2 s for the engine's last final.
- **[core] Documentation**: new [stt-formatting.md](../stt-formatting.md).

## Usage and billing - core+livekit+pipecat

- **[livekit+pipecat] Speech row `detail`**: `tts`, `stt`, `stt-aux`, and
  `stt-output` rows name the model or voice the engine was built with, so a
  rate card can price them by an exact line. Rows already written keep their
  old `detail`.
- **[pipecat] Scoped STT model**: an `options.stt.vendor` of `deepgram/<model>`
  or `google/<model>` now runs that model. It ran the default before.
- **[pipecat] STT minutes**: pipeline calls write an `stt` `milliseconds` row
  from the caller audio sent to the STT engine, silence included. Realtime
  calls with an external TTS no longer get `stt` rows.
- **[core] Subagent tokens**: subagent `llm` rows on a call, GPT-Live client
  delegation included, are finalised and priced when the call ends.
- **[pipecat] Browser bridge**: a bridged transfer from a browser caller closes
  the agent's realtime model session and ends its call record with
  `Agent left call, new bridged call: <id>`, as on LiveKit. After
  `accept_transfer`, the TransferAgent's session closes too.
- **[pipecat] Late transcript rows**: with `streamLog` off, a row that arrives
  after its call record has ended is posted on its own instead of being lost.
- **[core] Rate-line minimum**: a `unit: 'minute'` line may set
  `minimumSeconds`. A row with a non-zero duration is billed at least that
  long, then in 6-second steps. Its breakdown entry gains `minimumSeconds` and
  `minimumApplied`.
- **[core] Documentation**: new
  [billing-calls-from-usage.md](../billing-calls-from-usage.md), with worked
  examples and the permission each billing route needs.

## API server - core+ci

- **[core] Start-up**: the server opens its port only once its routes and
  boot-time database work are ready. It no longer builds response validators,
  and builds request validators without schema prose, so it uses less memory.
  `/api/api-docs` is unchanged.
- **[ci] Cloud Run probe**: staging and release deploys probe
  `GET /api/health` before sending traffic, every 3 s for up to 240 s.
- **[core] Better Auth**: at start the server makes `account.issuer` optional
  and drops its unique index, so new accounts can be created on databases set
  up for better-auth 1.7.1. `better-auth` is pinned to 1.7.18.
- **[ci] Test isolation**: the jest suites map `livekit-server-sdk` to a test
  double, so no test can create a room, a dispatch, or a SIP call, and the
  tests dial only fictional numbers.

## Upgrade notes

- **[core] Database schema migrates from v73 to v74**:
  - v74 `brands`, `organisations.brand`, and `auth_keys.brand`.
  - v72, v73, and v74 are now applied only by
    `node tools/agent-admin.js upgrade-db`, or one start with
    `DB_FORCE_SYNC=true`, not at start. Run it before starting the new API
    server. A feature whose step is missing answers 503 `<feature>_not_ready`.
- **[pipecat] New optional environment**: `VOICEBLENDER_INBOUND` and
  `LIFECYCLE_DRAIN_SECONDS`.
- **[core] Rate-card lines on speech `detail`**: some `tts` and `stt` rows
  change their `detail`. Check card lines against
  [billing-calls-from-usage.md](../billing-calls-from-usage.md) before rolling
  the workers, or rows a line was keyed on stop matching.
- **[core] `scripts/auth-issuer-backfill.mjs`** is removed. Do not run it from
  an older checkout: it puts back the `NOT NULL` that stops new accounts.
- **[livekit] Provider keys**: with `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` on, a
  stage with no plugin or no key now runs on LiveKit Inference and is billed to
  the LiveKit project. A LiveKit server without Inference fails such a stage.
- **[pipecat] `do-staging`**: apply it only together with call control set to
  hand agent calls to the worker. With one side switched and not the other,
  agent calls fail.
