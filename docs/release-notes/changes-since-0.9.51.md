# What changed since 0.9.51 — releases 0.9.52 and 0.9.53

A consolidated view of the two releases that followed 0.9.51, grouped by theme
rather than by release. Between them they add a complete usage-metering and
billing engine, the full human-transfer story (bridge to a human, transcribe and
record the segment, hand back to an agent with a summary), a rebuilt
multi-provider model layer, and substantial reliability, CPU and SIP-gateway
work on the voice stacks.

Items are tagged with the subsystem they land in **only where the release
specifies one**: **core** (platform API server — REST API, database, billing,
auth, model drivers), **livekit** (LiveKit voice worker, including its Ultravox
realtime plugin), **pipecat** (Pipecat voice worker), **sipbridge** (the SIP
gateway transport used by the Pipecat worker), **ci** (build/release pipeline).
An untagged item applies across the platform. The originating release is marked
per item, and net-of-both where something changed twice.

## Billing & metering

- **Per-call usage metering** across all voice and text platforms: LLM tokens, STT/TTS (metered on both duration and character bases), and call minutes, including consult/transfer legs. `GET /api/usage` gains cost totals, an uncosted-record count, and a `callId` filter for per-call breakdowns. *(0.9.52)*
- **Rate cards and costing engine**: named, dated, per-component rate cards; costs computed and frozen at transaction end; rate cards become immutable once referenced; a reconciliation sweep backfills, retries and re-costs corrected records. A platform default rate card is auto-assigned to new organisations. *(0.9.52)*
- **Rates admin API**: `/api/rates` CRUD and a `/api/rate-components` catalogue (RBAC-guarded); organisation rate history, prepaid balance with idempotent credit application, and per-user rate overrides. A least-privilege `billingService` role covers the balance-credit seam. *(0.9.52)*
- **Balance enforcement**: hot-path call refusal when an organisation is billing-blocked, a sweep trigger endpoint, and edge-triggered `balanceLow` / `balanceNegative` webhook callbacks. HMAC signing of balance-event submissions improved in 0.9.53. *(0.9.52, 0.9.53)*
- **Destination (carrier) billing**: tariff decks with longest-prefix matching, peak/off-peak schedules, connection and minimum charges; bulk deck upload (up to 48 MB) and a `POST /api/tariffs/{id}/quote` endpoint to price a hypothetical call. Destination charging is gated on chargeable trunks, with the outbound trunk stamped on every carried call. *(0.9.52)*
- **All per-minute usage is now billed in 6-second increments, rounded up**, matching standard carrier practice — introduced for destination tariffs in 0.9.52 and extended to platform per-minute components in the costing engine in 0.9.53. *(net of both)*
- **[livekit]** Consult legs are metered on every terminal path, including abnormal teardown. *(0.9.53)*
- `chargeableNumberLimit` can be set via the organisation billing-controls PATCH. *(0.9.53)*

## Transfers

- **Human-to-agent bridged transfers** (`bridgedTransferToAgent`) — **[livekit + pipecat]** bridge the caller to a human, monitor the bridge for DTMF, and hand the call back to an agent on demand, with a developer guide covering consultative transfer, DTMF hand-back and automated follow-up. *(0.9.52)*
- **Hand-back to an agent** — **[core + pipecat]** per-listener hand-back overrides let each listener route the returning call to its own agent and configuration, and the take-over call is seeded with `aplisay.transfer.*` metadata (who transferred, when, and why) so the receiving agent knows the context. *(0.9.53)*
- **Automated transfer summaries** — **[core + pipecat]** a summary agent is pre-fired as the bridge ends, and a new `transfer_summary` builtin gives the receiving agent a digest of the human conversation segment. *(0.9.53)*
- **Bridged-segment capture**: transcription via a stereo tap on the bridged leg, producing a transcript and call record for the human conversation segment *(0.9.52)*; **[pipecat + sipbridge]** recording of the same segment through the SIP gateway audio tap *(0.9.53)*.
- **Consultative-transfer fixes**: the consultation call record is closed correctly when the target rejects the transfer, and confidence-tone handling was fixed *(0.9.52)*; **[livekit]** the consult leg now hears the target it dialled straight away and consult teardown no longer strands call records, **[pipecat + sipbridge]** the consult callback path is routed correctly into the consult flow and consult call records carry correct caller and called identities *(0.9.53)*.

## DTMF

- **New builtin platform function `send_dtmf`** — agents can play a string of keypad digits to the far end of a live telephone call as **out-of-band** RFC 4733 (`telephone-event`) tones, the signalling downstream telephony equipment expects, rather than audible beeps mixed into the speech audio. *(0.9.52)*
- Received DTMF is now also recorded as a user turn in the transcript. *(0.9.52)*
- Bridged transfers monitor the bridge for DTMF, giving DTMF-triggered hand-back to an agent — **[livekit + pipecat]**. *(0.9.52)*
- No DTMF changes in 0.9.53.

Support limits for `send_dtmf`, from [send-dtmf.md](../send-dtmf.md):

- On **pipecat**, out-of-band DTMF is emitted by the SIP gateway that owns the media leg. The **sipbridge** and **voiceblender** gateways support it; the **Daily** and **FreeSWITCH** gateways do not, and `send_dtmf` returns a `FAILED` result explaining so. The active gateway is chosen at worker startup via `SIP_GATEWAY`.
- Adding a `send_dtmf` function to a `jambonz:`, `ultravox:` or `text:` agent is rejected when the agent is saved.
- On a **WebRTC / browser** session there is no telephone leg to relay tones to, so `send_dtmf` is rejected at call time with a `FAILED` result on both runtimes. The function can still be defined on an agent that takes both telephone and browser calls — it simply errors on the browser ones.

## Voice platform reliability & performance

- **WebRTC call setup is ~5 s faster** on hosted deployments: unnecessary STUN gathering disabled, plus trickle-ICE and renegotiation support on `/webrtc/offer`. *(0.9.52)*
- **[livekit] Process startup and runtime CPU significantly optimised** in the worker and its Ultravox realtime plugin (audio frame accumulation rework), guided by new profiling instrumentation (latent profiling plus on-demand profile hooks), including a more efficient audio drain path and exit forensics. *(0.9.53)*
- **[livekit]** Agent-initiated hangup no longer risks stranding a live call mid-teardown; **[livekit + ultravox]** when the Ultravox realtime provider ends the session itself the worker now ends the call promptly; outbound API calls from the worker no longer fail outright on a slow (>250 ms) connection attempt; failed worker startups no longer accumulate orphaned processes; caught errors are serialised correctly in worker logs and SIP participant attributes are read in the dotted form the media platform actually delivers. *(0.9.53)*
- **[sipbridge]** RTP egress is now paced correctly and transfer legs are routed properly on live PSTN traffic; SRTP offers are downgraded smoothly when a peer rejects them (415/606), with the working choice remembered per route; gateway builds fixed for Go 1.25. *(0.9.53)*

## Agents & tools

- **[livekit + pipecat] `promptMetadata`**: an agent can declare call facts — current date/time, caller number, custom metadata — that are stated directly in its system prompt, so the model knows them from its first utterance instead of needing a `get_metadata` tool round-trip (which on realtime providers freezes the conversation). *(0.9.53)*
- **[livekit + pipecat] Inactivity hangup**: `options.inactivity.hangup` ends the call after the inactivity prompt has gone unanswered three times, instead of holding an abandoned leg open until the session long-stop. *(0.9.53)*
- Agents can read the current date and time via `get_metadata` (`aplisay.dateTime`), and inbound SIP INVITE `X-` headers are surfaced as `metadata.aplisay.sipHeaders` across all inbound SIP paths. *(0.9.52)*
- **Ultravox**: the native driver honours the portable greeting, inactivity and `vendorSpecific` options; **[livekit]** the path passes `timeExceededMessage` through and drops an inert greeting fallback; **[pipecat]** the path registers data tools asynchronously and delivers tool results natively rather than as user text *(0.9.52)*. **[livekit + ultravox]** and **[pipecat]** the configured TTS language is passed through as the provider's language hint, and **[pipecat + ultravox]** provider tool definitions carry an explicit timeout so slow tool results are not abandoned early *(0.9.53)*.
- **[pipecat]** REST tool fixes: stored key references are resolved into request auth headers, and unsupplied optional parameters are omitted rather than sent as fabricated nulls. *(0.9.53)*
- **[core]** Agent-set saves no longer drop platform-wired keyed functions from member agents *(0.9.53)*; agent listeners can be moved between agent-set versions, guarded against unsafe live-deployment changes *(0.9.52)*.

## Text chat

- **Persisted chat sessions** with a history API; sessions survive disconnects with a re-attach grace window, the idle timeout is 15 minutes, and completions stream with tool calls announced at generation start rather than after completion. Text-chat post-mortems restored. *(0.9.52)*
- **Agent-builder assistant improvements**: explicit test-result frames, self-initiated test runs diagnosed as hidden turns, an independent `request_review` builtin, headless sessions, per-session model override, an optional `knowledge` seed for the opening turn, voice search for large catalogues (`list_voices` search mode with ranked matching), armed-key discovery via `GET /agents/{id}/keys`, an eval harness, and substantial token-efficiency work (prompt-cache tuning, slimmer tool echoes). *(0.9.52)*

## Models & providers

- **OpenAI and Gemini drivers rebuilt**: OpenAI on the Responses API with hosted MCP and reasoning replay; Gemini on the current `@google/genai` SDK with full nested tool-schema support. *(0.9.52)*
- **New providers**: DeepSeek, Kimi (Moonshot), and OpenRouter (curated multi-vendor catalogue, extensible via `OPENROUTER_MODELS`). *(0.9.52)*
- **Groq: net removed.** Rebuilt on a new shared chat-completions base with a refreshed catalogue in 0.9.52, then removed from the model layer entirely in 0.9.53 — its catalogue consisted of legacy open-weight models no longer worth carrying. Any agent still configured with a Groq model must be moved to another provider. *(net of both)*
- **Client-side MCP bridge** exposes MCP servers to providers without a hosted connector, with fail-closed key handling; missing provider keys now fail closed rather than silently falling back; the shared OpenAI-compatible driver base streams completions, fails fast on unresponsive endpoints and reports prompt-cache usage in metering; drivers self-heal an invalid tool/MCP history instead of looping forever on provider 400s; the Anthropic driver caches the whole conversation prefix (previously system prompt only); model entitlements are enforced on run/call paths, not just on reads. *(0.9.52)*

## Data retention

- **[core] `POST /calls/prune`**: org-scoped bulk pruning of stored call artifacts (transcripts, recordings, logs) for retention enforcement. *(0.9.53)*

## Observability

- **[pipecat]** Per-call invocation (debug) logs fixed, in a format the log timeline renders. Every tool and MCP call/result is logged into the invocation log at INFO level on both voice stacks, with consistent subagent transaction logging; workers log their build version at startup. *(0.9.52)*

## Numbers & trunks

- Buy-number flow support: `provisioned` can be set on `PUT /e164-ddi`, numbers can be allocated on global chargeable trunks, and organisations can carry a chargeable-number limit. superAdmin trunk management gains all-trunks listing (`scope=all`) and trunk creation via the API. *(0.9.52)*

## Auth & security

- Groundwork for a new OAuth-based authentication stack running alongside the existing sign-in: unified user schema migration, browser-navigation Google sign-in, bearer transport, and service identities for programmatic onboarding. Outbound webhooks hardened against SSRF; `GET /api/me` now includes the caller's organisation name for all roles. *(0.9.52)*
- **[core]** Auth email endpoints (password reset, verification) are now rate-limited per authenticated client rather than per source IP, so traffic arriving via a front-end proxy no longer shares a single bucket; forwarded client IPs are honoured only when authenticated with `AUTH_PROXY_SECRET`. An account-enumeration oracle is closed: a mail-send failure no longer produces a distinguishable error for registered-but-unverified addresses. **[core + workers]** Dependency (Dependabot) and CodeQL alert sweeps resolved across the codebase. *(0.9.53)*

## Ops & release engineering

- **[ci]** A beta release channel was introduced in 0.9.52 — builds from the integration branch are tagged and published as `beta-*` releases — and refined in 0.9.53 so already-built commits are promoted by manifest copy instead of being rebuilt. *(net of both)*
- **[livekit]** Docker Compose deployment added for the worker, with deploy scripting, drain support and environment bundling. *(0.9.53)*
- **[pipecat + ci]** Worker images can be built with a restricted transport set via `ONLY_TRANSPORTS`, skipping unused transport builds. *(0.9.53)*
- Handler families are automatically dropped from the model roster when their transport environment is unset, enabling clean single-transport builds. *(0.9.52)*

## Upgrade notes (cumulative from 0.9.51)

- **[core] Database schema migrates from v43 to v57** on first boot: usage records, rate cards, tariffs, balances, chat sessions and auth tables (v43 → v55, 0.9.52), then listener-level transfer overrides and transfer metadata (v55 → v57, 0.9.53).
- **New optional environment**: `DEEPSEEK_KEY`, `KIMI_KEY`, `OPENROUTER_KEY` / `OPENROUTER_MODELS` for the new providers; `APLISAY_OUTBOUND_TRUNK_ID`, from which workers stamp destination billing; `AUTH_PROXY_SECRET`, which authenticates forwarded client IPs for auth rate limiting; and **[pipecat/ci]** `ONLY_TRANSPORTS` for worker image build gating. `environment-example` has been audited and is now complete.
- **Removed**: the Groq driver and its models.
