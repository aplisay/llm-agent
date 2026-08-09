# 0.9.53 — release notes

This release completes the transfer story begun in 0.9.52 — calls handed to a human can now be handed back to an agent, with a summary of the human conversation — alongside a substantial reliability and CPU-efficiency pass on the LiveKit worker, SIP gateway hardening for live PSTN traffic, retention pruning, and billing refinements.

Each item is tagged with the subsystem it lands in: **core** (platform API server — REST API, database, billing, auth, model drivers), **livekit** (LiveKit voice worker, including its Ultravox realtime plugin), **pipecat** (Pipecat voice worker), **sipbridge** (the SIP gateway transport used by the Pipecat worker), **ci** (build/release pipeline).

## Transfers: agent hand-back — core + pipecat/sipbridge

- **[core + pipecat] Hand-back to an agent** after a bridged human transfer: per-listener hand-back overrides let each listener route the returning call to its own agent and configuration, and the take-over call is seeded with `aplisay.transfer.*` metadata (who transferred, when, and why) so the receiving agent knows the context.
- **[core + pipecat] Automated transfer summaries**: a summary agent is pre-fired as the bridge ends, and a new `transfer_summary` builtin gives the receiving agent a digest of the human conversation segment.
- **[pipecat + sipbridge] Bridged-segment recording**: the human conversation segment is now captured through the SIP gateway audio tap, alongside the transcription introduced in 0.9.52.
- **[livekit]** Consultative-transfer fixes: the consult leg now hears the target it dialled straight away; consult teardown no longer strands call records.
- **[pipecat + sipbridge]** Consultative-transfer fixes: the consult callback path is routed correctly into the consult flow, and consult call records carry correct caller and called identities.

## Voice platform reliability — livekit

- **[livekit]** Agent-initiated hangup no longer risks stranding a live call mid-teardown.
- **[livekit + ultravox]** When the Ultravox realtime provider ends the session itself, the worker now ends the call promptly instead of leaving the leg up.
- **[livekit]** Outbound API calls from the worker no longer fail outright on a slow (>250 ms) connection attempt — dual-stack connect behaviour is now configured sensibly.
- **[livekit]** Failed worker startups no longer accumulate orphaned processes.
- **[livekit]** Caught errors are serialised correctly in worker logs, and SIP participant attributes are read in the dotted form the media platform actually delivers.

## Performance — livekit

- **[livekit] Process startup and runtime CPU significantly optimised** in the worker and its Ultravox realtime plugin (audio frame accumulation rework), guided by new profiling instrumentation (latent profiling plus on-demand profile hooks), including a more efficient audio drain path and exit forensics.

## SIP gateway hardening — pipecat + sipbridge

- **[sipbridge]** RTP egress is now paced correctly, and transfer legs are routed properly on live PSTN traffic.
- **[sipbridge]** SRTP offers are downgraded smoothly when a peer rejects them (415/606), and the working choice is remembered per route.
- **[sipbridge]** Gateway builds fixed for Go 1.25.

## Agents & tools

- **[livekit + pipecat] `promptMetadata`**: an agent can declare call facts — current date/time, caller number, custom metadata — that are stated directly in its system prompt, so the model knows them from its first utterance instead of needing a `get_metadata` tool round-trip (which on realtime providers freezes the conversation). Implemented in both voice workers.
- **[livekit + pipecat] Inactivity hangup**: `options.inactivity.hangup` ends the call after the inactivity prompt has gone unanswered three times, instead of holding an abandoned leg open until the session long-stop. Implemented in both voice workers.
- **[livekit + ultravox]** and **[pipecat]** Realtime language hints: the configured TTS language is now passed through as the provider's language hint on both voice stacks.
- **[pipecat]** REST tool fixes: stored key references are resolved into request auth headers, and unsupplied optional parameters are omitted rather than sent as fabricated nulls.
- **[pipecat + ultravox]** Provider tool definitions now carry an explicit timeout, so slow tool results are not abandoned early.
- **[core]** Agent-set saves no longer drop platform-wired keyed functions from member agents.

## Billing & metering — core

- **[core] All per-minute usage is now billed in 6-second increments, rounded up**, matching standard carrier practice (previously introduced for destination tariffs, now applied to platform per-minute components in the costing engine).
- **[livekit]** Consult legs are metered on every terminal path, including abnormal teardown.
- **[core]** `chargeableNumberLimit` can be set via the organisation billing-controls PATCH.
- **[core]** HMAC signing of balance-event submissions improved.

## Data retention — core

- **[core] `POST /calls/prune`**: org-scoped bulk pruning of stored call artifacts (transcripts, recordings, logs) for retention enforcement.

## Models & providers — core

- **[core]** The Groq driver has been removed from the model layer (its catalogue consisted of legacy open-weight models no longer worth carrying); DeepSeek, Kimi, OpenRouter, and the rebuilt OpenAI/Gemini drivers from 0.9.52 are unaffected.

## Auth & security — core

- **[core]** Auth email endpoints (password reset, verification) are now rate-limited per authenticated client rather than per source IP, so traffic arriving via a front-end proxy no longer shares a single bucket; forwarded client IPs are honoured only when authenticated with `AUTH_PROXY_SECRET`.
- **[core]** An account-enumeration oracle is closed: a mail-send failure no longer produces a distinguishable error for registered-but-unverified addresses.
- **[core + workers]** Dependency (Dependabot) and CodeQL alert sweeps resolved across the codebase.

## Ops & deployment

- **[ci]** Beta release pipeline (introduced in 0.9.52) refined: already-built commits are promoted by manifest copy instead of being rebuilt.
- **[livekit]** Docker Compose deployment added for the worker, with deploy scripting, drain support, and environment bundling.
- **[pipecat + ci]** Worker images can be built with a restricted transport set via `ONLY_TRANSPORTS`, skipping unused transport builds.

## Upgrade notes

- **[core]** Database schema migrates from v55 to v57 on first boot (listener-level transfer overrides, transfer metadata).
- **[core]** New optional environment: `AUTH_PROXY_SECRET` (authenticates forwarded client IPs for auth rate limiting). **[pipecat/ci]** `ONLY_TRANSPORTS` (worker image build gating).
- **[core]** Removed: the Groq driver and its models — any agent still configured with a Groq model must be moved to another provider.
