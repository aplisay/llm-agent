# Voiceblender SIP ingress for the Pipecat agent

[Voiceblender](https://github.com/voiceblender/voiceblender) is a Go-based
programmable voice platform — a SIP B2BUA, RTP mixer, recording stack, and
REST + WebSocket control surface in a single binary. From the Pipecat
worker's point of view it sits in the same architectural slot as FreeSWITCH
+ mod_audio_stream + esl-poller: it terminates SIP, owns the media plane,
and dials our worker on an audio WebSocket per call.

This note is the operator's guide for running the voiceblender ingress
alongside the existing FreeSWITCH and Daily ones.


## Why this exists

The pipecat worker has had a swappable `SipGateway` abstraction since the
Daily and FreeSWITCH gateways shipped (see
[`docs/livekit-agent-architecture.md`](livekit-agent-architecture.md)
section 6). Voiceblender slots in as a third implementation:

| Gateway | SIP termination | Call control | Audio WS protocol |
|---|---|---|---|
| `daily` | Daily.co (hosted) | Daily SDK | Daily mediasoup |
| `freeswitch` | FreeSWITCH (self-hosted) | ESL via esl-poller sidecar | L16 PCM + JSON (`FreeSwitchAudioStreamSerializer`) |
| `voiceblender` | Voiceblender (self-hosted) | REST + VSI WS to voiceblender | **Stock Pipecat protobuf** (`ProtobufFrameSerializer`) |

The protobuf wire format is the headline simplification — voiceblender
speaks the same `pipecat.Frame` proto that Pipecat's own
`examples/websocket` sample uses, so the worker side requires no custom
serializer.


## Architecture

```
                    +-----------------------+
        SIP/RTP --> |   voiceblender (Go)   |
                    |  - B2BUA / mixer      |
                    |  - REST :8080         |  REST + VSI WS
                    |  - VSI WS /v1/vsi     | <-----------------+
                    +-----------+-----------+                   |
                                |                               |
                                |  WS /voiceblender/agent/...   |
                                |  Pipecat protobuf @ 16kHz     |
                                v                               |
                    +-----------+-----------+                   |
                    |  pipecat-worker       |                   |
                    |                       |                   |
                    |  VoiceblenderSipGate- +---<---<---<---<---+
                    |  way:                 |
                    |   - VSI subscriber    |
                    |   - REST client       |
                    |  /voiceblender/agent/ |
                    |   {session_id} WS     |
                    +-----------+-----------+
                                |
                                | HTTP to llm-agent
                                v
                          (api_client.*)
```

Two long-lived control connections live on the worker side:

1. **`VoiceblenderSipGateway`'s VSI subscriber task** — opens
   `GET /v1/vsi` (WebSocket) at boot, reconnects with backoff on drop,
   filters events by `app_id`. Drives:
     - `leg.ringing` → agent resolution + `POST /v1/legs/{id}/answer`
       + `POST /v1/legs/{id}/agent` with our worker's per-session WS URL.
     - `leg.disconnected` → releases the per-session leg-done event so the
       WS handler exits.
     - `leg.transfer_initiated|_requested|_progress|_completed|_failed` →
       pushes state into `CallSession.transfer_state`.

2. **`httpx.AsyncClient`** (in-band, per-call) — for REST control:
   `POST /v1/legs` (outbound originate), `DELETE /v1/legs/{id}` (hangup),
   `POST /v1/legs/{id}/transfer` (REFER blind / attended),
   `POST /v1/legs/{id}/dtmf` (`{digits}` — play out-of-band RFC 4733 DTMF to
   the far end; drives the `send_dtmf` builtin, see
   [send-dtmf.md](send-dtmf.md)).


## Call flows

### Inbound

1. SIP INVITE arrives at voiceblender → voiceblender emits
   `{type: "leg.ringing", leg_id, from, to, sip_headers, ...}` on VSI.
2. Worker's VSI subscriber resolves the agent for the dialled number
   using the same lookup chain as Daily dial-in and FreeSWITCH
   (`phone_registration` → trunk+number → number). Returns
   `(instance, agent)` or rejects the leg with `DELETE /v1/legs/{id}`.
3. Worker stashes a `PendingAttach` keyed by a fresh `session_id`, then
   POSTs `/v1/legs/{id}/answer` and `/v1/legs/{id}/agent` with
   `agent_id = ws://worker/voiceblender/agent/{session_id}`.
4. Voiceblender opens a WebSocket to that URL. The worker's WS handler:
     - finds the pending attach, builds a `FastAPIWebsocketTransport` with
       `ProtobufFrameSerializer`,
     - calls `setup_inbound_call(...)` to mint the persisted `Call` record
       and the `CallSession`,
     - runs the Pipecat `PipelineRunner` to completion.
5. On `leg.disconnected` (or pipeline end → `shutdown()` →
   `DELETE /v1/legs/{id}`) the session ends, the call record is
   `end_call`'d, and any flush hooks fire.

The `sip_headers` on the `leg.ringing` event carry the INVITE's `X-` headers
(voiceblender's SIP ingress extracts every `X-*` header from the INVITE).
Beyond the `X-Aplisay-*` routing contract, the gateway collects **all** of
them into `metadata.aplisay.sipHeaders` (lowercased) when it builds the
inbound call context, so agents can read per-call context the carrier/SBC
attached. See [`sip-headers.md`](sip-headers.md).

> **Field name note.** The event field is `sip_headers`
> (`LegRingingData.SIPHeaders` in the voiceblender source). The worker's
> `_voiceblender_resolve_agent` and a couple of gateway docstrings still call
> it `custom_headers` — a stale misnomer that resolves to `None`, so the agent
> lookup there falls through to the dialled-number path (it does not read the
> trunk / registration headers). `_on_leg_ringing`, which builds the
> `InboundCallContext`, reads the correct `sip_headers` field.


### Outbound

1. `lib/handlers/pipecat.js` (llm-agent) POSTs `/dispatch` with kind
   `outbound` to the worker.
2. Worker calls `setup_outbound_call` → `gateway.originate(params)`.
3. `originate()` POSTs `/v1/legs` to voiceblender with `agent` set to
   `ws://worker/voiceblender/agent/{session_id}`, then stashes a pending
   attach (`agent`/`instance` left empty — the dispatch caller already
   has them), and **blocks on a future**.
4. Voiceblender places the outbound call and (on answer) opens the audio
   WS. The worker's WS handler enters the **outbound branch**: it builds
   the transport, calls `gateway.setup_inbound(...)` which constructs the
   `_VbGatewaySession` and **resolves the originate future**.
5. `setup_outbound_call` returns; the dispatch endpoint spawns
   `_run_session` as a background task and returns 200.
6. The WS handler then awaits a per-session "leg done" event. The VSI
   subscriber sets it on `leg.disconnected`. The runner closes the
   transport when the pipeline ends → shutdown → DELETE leg → VSI
   event → WS handler exits.


### Transfer (REFER)

`CallSession.transfer()` (function-tool surface) calls
`gateway_session.transfer(req)`. The voiceblender gateway maps:

| Aplisay `operation` | Voiceblender primitive |
|---|---|
| `blind` (REFER) | `POST /v1/legs/{id}/transfer` (in-dialog REFER) |
| `blind` + `force_bridged` | agent-less `POST /v1/legs` + ephemeral room bridge (`_do_dial_bridge`) |
| `consultative` | agent-attached consult leg; finalise via room bridge (`bridge_with`) |

Progress events arrive on VSI:
`leg.transfer_initiated` → `leg.transfer_progress` (per NOTIFY sipfrag) →
`leg.transfer_completed` | `leg.transfer_failed`. The gateway updates
`CallSession.transfer_state` from each event so the `transfer_status`
tool reflects the current SIP-side state.


## Operations

### Compose profiles

The compose file ships three SIP-ingress profiles. Exactly one runs at a
time because they all want UDP/5060 and the host's RTP port range:

```bash
# FreeSWITCH (current default)
docker compose --profile freeswitch up -d

# Voiceblender
docker compose --profile voiceblender up -d

# Daily (no SIP container — cloud-only)
docker compose --profile daily up -d
```

The `pipecat-worker` container carries every profile so any
`docker compose up` brings it along with whichever ingress you've chosen.

On a host running the deploy script, the `.env` controls profile
selection via `COMPOSE_PROFILES`. `deploy-node.sh` brings *all* profiles
down before bringing up the selected one, so switching ingresses is
non-disruptive to the host's port allocation.


### Required env vars (voiceblender ingress)

| Variable | Default | Purpose |
|---|---|---|
| `SIP_GATEWAY` | `freeswitch` | Set to `voiceblender` to instantiate the voiceblender gateway in the worker. **Must match `COMPOSE_PROFILES`.** |
| `COMPOSE_PROFILES` | `freeswitch` | `voiceblender` to start the voiceblender container. |
| `VOICEBLENDER_BASE_URL` | `http://127.0.0.1:8080` | Where the worker reaches the voiceblender REST + VSI endpoints. With host networking this is localhost. |
| `VOICEBLENDER_API_KEY` | — | Shared secret; sent as Bearer on REST + VSI. Set the same value on the voiceblender container's `API_KEY` env. |
| `VOICEBLENDER_APP_ID` | `aplisay-pipecat` | Tag the worker uses to filter VSI events. Voiceblender supports regex matching here for multi-tenancy. |
| `VOICEBLENDER_WORKER_WS_BASE` | `ws://127.0.0.1:8082` | Where voiceblender will dial the worker's per-session audio WS. On macOS/Windows Docker Desktop, this needs to be `ws://host.docker.internal:8082`. |
| `VOICEBLENDER_VERSION` | `v0.6.0` | Image tag pulled from `ghcr.io/voiceblender/voiceblender`. |
| `VOICEBLENDER_SIP_PORT` | `5060` | UDP. Set to e.g. `5070` if you ever need to co-host with another SIP UA. |
| `VOICEBLENDER_SIP_TLS_PORT` | `0` | `0` disables TLS. Set to `5061` for WhatsApp / encrypted SIP. |
| `VOICEBLENDER_RTP_PORT_MIN/MAX` | `10000-20000` | UDP. Configure firewall accordingly. |
| `VOICEBLENDER_HTTP_PORT` | `8080` | REST + VSI port. Remap if it collides with another service on the host. |


### What stays in the worker (vs ceded to voiceblender)

| Concern | Owner |
|---|---|
| SIP signalling (INVITE / BYE / REFER / NOTIFY) | voiceblender |
| RTP media termination, codec negotiation | voiceblender |
| Audio framing on the worker WS | Pipecat (`ProtobufFrameSerializer`) |
| Function-tool callable surface (LLM tools, `hangup`, `transfer`) | worker |
| Transfer state machine | worker (driven by VSI events) |
| Greeting orchestration (text / instructions / muting) | worker |
| Recording (AES-GCM encrypted OGG/Opus → GCS) | worker |
| Transcript forwarding (transaction-log REST) | worker |
| Realtime model bindings (OpenAI Realtime, Gemini Live, Ultravox) | worker |
| Pipeline-mode bindings (STT/LLM/TTS) | worker |
| Concurrency / fallback chain | worker |
| Browser path (`/webrtc/offer`) | worker — unrelated, unaffected |

Voiceblender's own recording (to S3, unencrypted) and TTS/STT capabilities
are intentionally not wired up — our worker pipeline already does richer
versions of both and shoves them through the same code paths regardless
of ingress.


### Manual test plan

1. **Up the stack**
   ```bash
   cd agents/pipecat
   SIP_GATEWAY=voiceblender COMPOSE_PROFILES=voiceblender \
     docker compose -f docker-compose.dev.yml --profile voiceblender up
   # in another terminal:
   SIP_GATEWAY=voiceblender uv run python -m pipecat_aplisay
   ```

2. **Health checks**
   ```bash
   curl -s http://127.0.0.1:8080/v1/health      # voiceblender
   curl -s http://127.0.0.1:8082/                # pipecat-worker
   ```
   Worker logs should show `voiceblender VSI subscriber connected`.

3. **Inbound end-to-end**
   Register a softphone (baresip, Zoiper) against voiceblender, dial a
   number wired to an agent. Expect:
     - `voiceblender VSI subscriber: leg.ringing` in worker logs
     - Worker logs the agent resolution + `POST /v1/legs/{id}/agent`
     - WebSocket opens at `/voiceblender/agent/{session_id}`
     - Greeting fires (if configured)
     - Transcript appears in the playground UI
     - Hangup from softphone → `voiceblender leg disconnected` →
       call record `end_call`'d

4. **Outbound origination**
   ```bash
   curl -X POST http://127.0.0.1:8082/dispatch \
     -H "authorization: Bearer $PIPECAT_DISPATCH_TOKEN" \
     -H "content-type: application/json" \
     -d '{
       "kind": "outbound",
       "sessionId": "test-1",
       "callId": "...",
       "callerId": "+441234567890",
       "calledId": "+441234567891",
       "instanceId": "<existing-instance-id>"
     }'
   ```
   Worker should `POST /v1/legs` → voiceblender places the call →
   voiceblender opens the audio WS → pipeline runs.

5. **REFER transfer**
   Trigger the `transfer` function tool from a live call. Expect
   `POST /v1/legs/{id}/transfer` on the wire and
   `leg.transfer_initiated` → `_progress` → `_completed` in VSI logs,
   each one updating `CallSession.transfer_state`.

6. **Regression check (FreeSWITCH unaffected)**
   ```bash
   docker compose --profile voiceblender down
   docker compose --profile freeswitch up -d
   ```
   Inbound + outbound on FreeSWITCH should still work identically.


## Code map

| File | What |
|---|---|
| `agents/pipecat/pipecat_aplisay/sip_gateway/voiceblender_gateway.py` | `VoiceblenderSipGateway` + `_VbGatewaySession` |
| `agents/pipecat/pipecat_aplisay/sip_gateway/__init__.py` | Exports the new gateway alongside Daily/FreeSWITCH |
| `agents/pipecat/pipecat_aplisay/worker.py` | `SIP_GATEWAY=voiceblender` branch in `lifespan`, `_voiceblender_resolve_agent`, `WS /voiceblender/agent/{session_id}` handler |
| `agents/pipecat/docker-compose.yml` | Profiles: `freeswitch`, `voiceblender`, `daily` |
| `agents/pipecat/docker-compose.dev.yml` | Same profile layout for the dev stack |
| `agents/pipecat/deploy/gcp/docker-compose.gcp.yml` | Production / staging compose with profiles |
| `agents/pipecat/deploy/gcp/deploy-node.sh` | Brings all profiles down before bringing the selected one up |
| `agents/pipecat/deploy/gcp/env-example-{staging,production}` | `COMPOSE_PROFILES` + `SIP_GATEWAY` + voiceblender knobs |


## Human-to-agent transfers (`options.bridgedTransferToAgent`)

See [`call-transfers.md`](call-transfers.md#human-to-agent-transfers-bridgedtransfertoagent)
for the user-facing contract. On the voiceblender topology the pieces are:

1. A bridged transfer (native dial+bridge, or a consultative finalise)
   puts the caller and target legs in an ephemeral room; the gateway
   session records `bridge_room_id` / `bridge_peer_leg_id` and is marked
   `bridged` so the worker's teardown never deletes a leg that now
   belongs to the two humans.
2. `dtmf.received` VSI events for the **target leg** (which has no
   CallSession) are routed to a watcher registered by
   `bridged_transfer.arm_voiceblender_bta_watch(...)`; the watch dies
   with either bridged leg (`leg.disconnected`).
3. On a sequence match the worker reserves a child call record, stashes
   a `TakeoverPayload` keyed by a fresh session id, then
   `DELETE /v1/legs/{target}` → `DELETE /v1/rooms/{room}/legs/{caller}`
   → `POST /v1/legs/{caller}/agent/pipecat` — voiceblender dials
   `/voiceblender/agent/{session_id}` and the WS handler builds the
   incoming agent's CallSession from the stash.
4. With `options.bridgedTransferTranscribe` set, the worker also starts
   voiceblender's **native per-leg STT** (`POST /v1/legs/{id}/stt`,
   provider/language from the option) on both bridged legs at bridge
   time. Final `stt.text` VSI events are routed per leg into a
   speaker-labelled transcript (`bridge_transcript.py`) logged against
   the bridged-segment call record and, on a DTMF hand-back, injected
   into the incoming agent's prompt. Media never leaves the room mixer.

## Known limitations / follow-ups

- **`bridged` transfers**: the native dial+bridge path
  (`_do_dial_bridge`) dials the target as an agent-less leg and joins
  both legs in an ephemeral voiceblender room. Bridged legs are marked
  on the gateway session so worker teardown leaves them alive.
- **Voiceblender's native recording** is left disabled; the worker
  handles recording via `AudioBufferProcessor` and the AES-GCM/GCS
  pipeline that ships in `pipecat_aplisay/recording/`.
- **TLS / WSS** for the audio WS — voiceblender's `agent_id` accepts
  `wss://`, but the worker's `/voiceblender/agent/{session_id}` route
  is plain `ws://` today. For production behind a TLS load balancer,
  proxy WSS in front of the worker and set
  `VOICEBLENDER_WORKER_WS_BASE=wss://...`.
- **Multi-tenancy** via `VOICEBLENDER_APP_ID` regex filter is supported
  by voiceblender's VSI subscriber but the worker currently uses a
  single app_id. If we want per-tenant routing we can promote the
  app_id resolution into the agent lookup chain.
