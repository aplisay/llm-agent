# Release 0.9.54 (draft) - SIP registration observability, registration trunks, auxiliary transcription, media quality

> Draft. Covers changes merged to `next` since the 0.9.53 release point
> (69 pull requests, 9 August - 3 September 2026). The version number is
> provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## SIP registration observability - core

- **[core] New alpha B2BUA stack**: registration trace, probe, heartbeat,
  discovery, and private-address features depend on a new B2BUA implementation
  written from scratch. They are available only for registrations on that stack;
  older FreeSWITCH-backed nodes report them as unsupported.
- **[core] SIP trace API**: `GET /api/phone-endpoints/{id}/trace` lists recent
  SIP exchanges, including summary, outcome, SIP code, timings, byte counts,
  pinned entries, and eviction counts. `GET .../trace/{transactionId}` returns a
  full transcript, decode, or pcap.
- **[core] On-demand registration probes**: `POST
  /api/phone-endpoints/{id}/probe` runs a REGISTER attempt for the selected
  registration. `GET .../probe/{probeId}` returns the report and
  `.../events` streams progress.
- **[core] Trace and probe proxying**: trace data is proxied from the owning B2BUA
  node rather than stored centrally. Node calls use private-CA TLS, bearer-token
  auth, bounded timeouts, SSRF checks, and optional node allow-listing.
- **[core] B2BUA fleet view**: nodes heartbeat to
  `POST /api/agent-db/b2bua-nodes` with stack, version, registration counts,
  failure counts, and load. `GET` returns the latest reported fleet state,
  including stale nodes.
- **[core] Regclient discovery**: unknown nodes are probed by capability, cached,
  and reported as `501 trace-api-unavailable` when the trace API is unsupported.
  `504` now means a trace-capable node did not answer.
- **[core] Private node addresses**: nodes can report a private VPC address.
  `REGCLIENT_USE_PRIVATE_NODE_ADDRESS` prefers that address after validation, with
  fallback to the public address.
- **[core] Scoped access**: traces and probe reports require
  `phoneEndpoint:read`; starting a probe requires `phoneEndpoint:update`.
  `B2BUA_HEARTBEAT_TOKEN` scopes node heartbeats, and signed probe handles support
  migration and token rotation.
- **[core] Registration ownership checks** now use `userOwnsRow`, closing the
  org-less tenant access case.
- **[core] Documentation**: new
  [registration-trace-and-probe-api.md](../registration-trace-and-probe-api.md),
  and the phone-registration `options` union is documented in OpenAPI.

## Numbers, trunks and registrations - core + workers

- **[core] Phone-number identity** moves to a surrogate `id` primary key
  (schema v61). Numbers are unique per organisation and per trunk, with the
  unallocated pool still unique by number.
- **[core + livekit + pipecat] Inbound calls** now resolve DDIs by `(number,
  trunk)` instead of platform-wide number lookup.
- **[core] Registration trunks** (schema v62) let a registration created with
  `trunk: true` own a `trunks` row. `phone_registrations` gains `trunk_id`,
  `did_source`, and `did_country`.
- **[core + livekit + pipecat] Outbound calls from registration-trunk numbers**
  egress through that registration's B2BUA.
- **[core] Number reservations for chargeable trunks** (schema v63) add
  `POST /number-reservations` and the `phoneEndpoint:reserve` action. Claims onto
  chargeable trunks require a valid `reservationRef` unless the caller holds
  `trunk:create`.
- **[core] Number reassignment**: `PUT /phone-endpoints/{number}` accepts
  `organisationId` for superAdmin number moves and rejects moves while the number
  is attached to an agent.
- **[core + pipecat + sipbridge] Per-trunk SRTP offer control**:
  `Trunk.flags.srtp = false` suppresses encrypted-media offers on originated legs
  for that trunk.

## Speech observability - core + livekit + pipecat

- **[core + livekit + pipecat] Auxiliary STT**: `options.stt.aux` runs a second
  STT engine over caller audio. Finals are logged as `user-aux` and metered as
  `stt-aux` / `stt-aux:<engine>` (schema v64).
- **[core + livekit + pipecat] Output audit STT**: `options.tts.output` runs STT
  over agent audio. Finals are logged as `agent-speech` and metered as
  `stt-output` (schema v65).
- **[livekit] STT taps** attach to the caller track and to `session.output.audio`.
  They re-arm across agent handovers, pause during consult holds, and stop when
  agent media is detached.
- **[pipecat] STT taps** run as side pipelines. Caller auxiliary STT follows the
  WebRTC relay tap; output audit STT reads TTS frames before transport output.
- **[core + livekit + pipecat] Metering and errors** now reflect engine-reported
  usage where available, avoid billing unaccepted audio, log engine failures, and
  arm correctly for outbound legs.
- **[core] `GET /models`** now advertises `hasAuxStt` and `hasOutputStt`.
- **[core] Documentation**: new [auxiliary-stt.md](../auxiliary-stt.md).

## WebRTC media quality - pipecat

- **[pipecat] WebRTC underrun stats** record starvation duration, lateness, cause,
  and queue depth during agent speech.
- **[pipecat] Output cushioning** adds configurable queue target/cushioning and
  pause stretching to reduce mid-speech starvation without changing voiced audio.
- **[pipecat + sipbridge] Underrun logging** is summarised once per call, with
  optional per-event logging via `WEBRTC_UNDERRUN_LOG_MS`.
- **[pipecat] Trickle ICE routing** forwards ICE PATCHes to the node that owns the
  peer connection when a load-balanced request lands elsewhere.
- **[pipecat] Peer-connection restarts** now re-key the peer registry after
  `restart_pc`.
- **[pipecat] `/healthz`** adds thread-spawn, session, peer-registry, and thread
  watermark checks. Kubelet probes now use HTTP health checks instead of
  `tcpSocket`.

## SIP gateway - sipbridge

- **[sipbridge] G.711 A-law encoding** has been rewritten and checked against
  standard expansion tables, vectors, and round-trip monotonicity.
- **[sipbridge] RTP silence fill** keeps media flowing through silent slots, with
  `SIPBRIDGE_RTP_SILENCE_FILL=false` available to restore prior behaviour.
- **[sipbridge] TLS outbound Contact** now advertises the correct TLS Contact for
  outbound legs.
- **[sipbridge] Pacer starvation reporting** counts silence-fill runs that end
  when real audio resumes and buckets queue depth.
- **[pipecat + sipbridge] Image pulls** now use `imagePullPolicy: Always` for the
  mutable sipbridge image tag.

## Failover, agents and models - core + workers

- **[core + livekit + pipecat] `options.fallback.message`** adds a fixed TTS
  fallback announcement after model fallback is exhausted and before number
  fallback. The synthesised audio is cached in GCS by content, voice, vendor, and
  language.
- **[pipecat] Confidence tone output** now uses the transport's sample rate, and a
  final output-rate guard normalises outbound frames before transport output.
- **[core + livekit + pipecat] Ultravox interruption defaults** now use
  `minimumInterruptionDuration: 0.48s` when no explicit
  `vendorSpecific.ultravox.vadSettings` block is supplied. Pipecat now honours
  this vendor-specific option.
- **[core] Model aliases** whose targets are no longer offered are removed from
  the advertised roster.
- **[core] OpenAI hosted-MCP replay** now retains completed MCP results by
  rewriting them as function-call/output pairs on stateless replay.

## Billing and rates - core

- **[core] Rate-card period-overlap constraint removed** (schema v59). Rate-card
  resolution remains deterministic by latest `start_date` at `billedAt`; duplicate
  `(name, start_date)` remains rejected.
- **[core] `GET /api/me/rates`** returns the caller organisation's current rate
  card behind `usage:read`, including a `rated: false` state when no card applies.
- **[core] Call cost totals**: `GET /calls`, `GET /agents/{agentId}/calls`, and
  `GET /calls/{callId}` return finalised call cost in `costMicros`, or `null`
  when not yet costed.
- **[core] `agentLimit`** is now editable through organisation billing controls.
- **[core] `billingService`** can assign an organisation's rate card. New
  `scripts/verify-billing-service.mjs` checks deployed billing credentials.

## Security and authorisation - core + workers

- **[core + livekit + pipecat] Outbound destination authorisation** is now shared
  by every worker through `lib/outbound-authorisation.js` and
  `POST /api/agent-db/outbound-authorisation`. Chargeable trunks use operator
  trunk policy plus destination rating; agent policy can only narrow it.
- **[core] Documentation**: new
  [outbound-call-authorisation.md](../outbound-call-authorisation.md).
- **[core] `Agent.keys` credentials** are encrypted at rest with
  `CREDENTIALS_KEY`; telemetry masks secret material.
- **[core] Credentials-at-rest audit**:
  `tools/credentials-audit.js` classifies plaintext, current-key encrypted, and
  foreign-key encrypted values, with an optional `--sweep` mode for manual
  encryption. New [credentials-at-rest.md](../credentials-at-rest.md).
- **[core] RBAC checks** tightened for organisation status changes, user status
  changes, provisional-organisation activation, and cross-tenant user moves.
- **[core] `emailVerified`** is now editable for privileged cross-tenant callers
  and remains blocked on self-edit.
- **[core] `onboardingService`** can read and update organisations, without
  delete, role, billing, or product access.
- **[core] Verification and reset email endpoints** use bounded background mail
  handling so mail-provider latency is not observable from request timing.
- **[core] `POST /api/auth/sign-up/email`** now requires `AUTH_PROXY_SECRET` and
  is reserved for the trusted front-end seam. `/api/users/signup` remains the
  public self-signup path.
- **[core] Email personas** are configurable via `x-email-brand` and
  `EMAIL_BRANDS` / `EMAIL_BRANDS_FILE`.
- **[core] `GET /api/me`** reports organisation name again.

## Text chat and builder - core

- **[core] Chat resume from history**: `POST /agents/{agentId}/chat` accepts
  bounded `history` and `resumedFrom` fields, and `chat_sessions.resumed_from`
  records lineage.
- **[core] Tool failure messages** reaching the model now omit internal set,
  agent, and draft ids.
- **[core] Tool-call rate limiting** has been reworked, with transfer-status
  polling exempted.

## Ops, deployment and dependencies

- **[core + livekit + pipecat + ci] Docker builds** now include `yarn.lock` and
  use `--frozen-lockfile` so deployed images use committed dependency versions.
- **[core] better-auth 1.7.1** is adopted deliberately, with
  `scripts/auth-issuer-backfill.mjs` for the populated `account.issuer`
  migration.
- **[ci] Secret publication** is pinned to the intended Kubernetes context and
  environment.
- **[pipecat/ops] SIP capacity labels** are documented as node-pool labels, with
  troubleshooting for autoscaled pools.
- **[pipecat/ops] DigitalOcean certificate ids** refreshed in staging and
  production overlays, with renewal guidance documented.
- **[livekit] Worker shared-library copies** are now real directories, with tests
  checking imported `agent-lib` directories against their `lib` sources.
- **[core] Beta API ingress** moved to the new public hostname and removed the
  retired hostname from the certificate.
- **[core] Outbound-authorisation schema** now accepts nullable optional
  properties from Pipecat.
- **[core] `tools/purge-user`** now connects to the front-end database using the
  application's client-certificate mTLS env file.
- **[livekit] COS runner** initialisation added.

## Upgrade notes

- **[core] Database schema migrates from v57 to v65** on first boot:
  - v58 `trunks.outbound_call_filter`.
  - v59 drops the `rate_cards` period-overlap EXCLUDE constraint.
  - v60 `b2bua_nodes.private_address`.
  - v61 changes `phone_numbers` identity and uniqueness.
  - v62 adds registration-trunk fields to `phone_registrations`.
  - v63 adds `number_reservations`.
  - v64 adds transaction-log type `user-aux`.
  - v65 adds transaction-log type `agent-speech`.
  - The v64/v65 enum additions require `DB_FORCE_SYNC`.
- **[core] New optional environment**: `REGCLIENT_API_TOKEN`,
  `REGCLIENT_API_TOKEN_PREVIOUS`, `REGCLIENT_API_PORT`, `REGCLIENT_CA_CERT`,
  `REGCLIENT_NODE_ALLOWLIST`, `REGCLIENT_PROBE_NODES`,
  `REGCLIENT_ALLOW_PRIVATE_NODES`, `REGCLIENT_USE_PRIVATE_NODE_ADDRESS`,
  `REGCLIENT_DISCOVERY_TIMEOUT_MS`, `REGCLIENT_CAPABILITY_TTL_MS`,
  `REGCLIENT_UNSUPPORTED_TTL_MS`, `TRACE_PROXY_TIMEOUT_MS`,
  `B2BUA_HEARTBEAT_TOKEN`, `EMAIL_BRANDS`, and `EMAIL_BRANDS_FILE`.
- **[pipecat] New optional environment**: `WEBRTC_OUTPUT_CUSHION_MS`,
  `WEBRTC_OUTPUT_TARGET_MS`, `WEBRTC_STRETCH_EVERY`, `WEBRTC_UNDERRUN_STATS`,
  `WEBRTC_UNDERRUN_LOG_MS`, and `WEBRTC_PEER_HOST`.
- **[sipbridge] New optional environment**: `SIPBRIDGE_RTP_SILENCE_FILL`.
- **[core] `AUTH_PROXY_SECRET`** is required for
  `POST /api/auth/sign-up/email`; deploy the paired front-end header change
  before enabling this server change.
- **[core] `APLISAY_OUTBOUND_TRUNK_ID`** now affects outbound destination
  authorisation as well as billing attribution. Configure the same value on the
  API service and both voice workers.
- **[core] Rate cards** may now overlap by period; duplicate `(name, start_date)`
  remains invalid.
- **[core] Chargeable-trunk number claims** require a reservation unless the
  caller holds `trunk:create`. Existing numbers are unaffected.
- **[core] Cross-tenant status updates** are stricter for users and
  organisations.
- **[pipecat/ops] SIP worker probes** now use `GET /healthz`.
- **[ops] SIP capacity labels** should be applied to the node pool, not
  individual nodes.
