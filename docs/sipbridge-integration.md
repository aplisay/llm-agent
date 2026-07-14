# sipbridge — minimal in-tree SIP UAS

`agents/pipecat/sipbridge/` is a small Go container that does only what
we need it to do: accept SIP INVITEs, terminate RTP, and proxy audio to
the Pipecat worker over a WebSocket carrying Pipecat protobuf frames.
~2 kLoC total, no codegen, no cgo, ~25 MB final image.

This note covers the architecture, the per-phase scope, the wire
contract with the rest of the stack.


## Why this exists

The pipecat worker has a swappable `SipGateway` abstraction (section 6
of [`docs/livekit-agent-architecture.md`](livekit-agent-architecture.md)).
We now have four implementations:

| Gateway | SIP termination | Call control | Audio WS protocol | Footprint |
|---|---|---|---|---|
| `daily` | Daily.co (hosted) | Daily SDK | Daily mediasoup | none on host |
| `freeswitch` | FreeSWITCH (self-hosted) | ESL via esl-poller sidecar | L16 PCM + JSON (`FreeSwitchAudioStreamSerializer`) | ~3 containers, ~hundreds of MB |
| `voiceblender` | Voiceblender (self-hosted) | REST + VSI WS | Pipecat protobuf (`ProtobufFrameSerializer`) | 1 container, ~80 MB |
| `sipbridge` | **sipbridge (in-tree, self-hosted)** | **REST + WS request headers** | **Pipecat protobuf (`ProtobufFrameSerializer`)** | **1 distroless container, ~25 MB** |

sipbridge is the result of asking "what's the smallest thing that
would work?" against the constraints we actually have: no mixing, no
multi-party, no native recording, no REGISTER/registrar, blind +
warm-transfer-by-REFER are sufficient, TLS/SRTP can be a later pass.


## Architecture

```
                  +-----------------------+
       SIP/RTP -->|   sipbridge (Go)      |
                  |  - sipgo UAS          |
                  |  - pion/rtp           |
                  |  - hand-rolled G.711  |
                  |  - REST :8090         |
                  |  - WS client (out)    |
                  +-----------+-----------+
                              |
                              | WS /sipbridge/agent/{session_id}
                              | Pipecat protobuf @ 16kHz
                              | SIP headers attached as HTTP request headers
                              v
                  +-----------+-----------+
                  |  pipecat-worker       |
                  |                       |
                  |  SipBridgeSipGateway  |
                  |  /sipbridge/agent/    |
                  |   {session_id} WS     |
                  +-----------+-----------+
                              |
                              | HTTP to llm-agent
                              v
                        (api_client.*)
```

Two things differ from the voiceblender path:

1. **Dispatch metadata flows inline on the WS handshake** as HTTP
   request headers (`X-Sipbridge-From`, `X-Sipbridge-To`,
   `X-Sipbridge-Call-ID`, plus the `X-Aplisay-*` / `X-Lk-*` contract
   from section 6 of the architecture doc). There is no VSI-like event
   stream or webhook receiver — the worker resolves the target agent
   at WS accept time using exactly the same lookup chain Daily dial-in
   and FreeSWITCH use.

2. **No mixer / no recording / no native TTS-STT.** The worker handles
   all of those; sipbridge is solely a media-and-signalling shim.


## Codebase layout

```
agents/pipecat/sipbridge/
├── cmd/sipbridge/main.go              entrypoint, signal handling, lifecycle
├── internal/
│   ├── config/config.go                env-var loader
│   ├── sip/
│   │   ├── server.go                   sipgo wiring: INVITE / ACK / BYE
│   │   ├── sdp.go                      offer parsing + answer building (PCMU/PCMA)
│   │   └── state.go                    monotonic SDP session-id counter
│   ├── rtp/
│   │   └── session.go                  UDP socket pair, RTP framing via pion/rtp
│   ├── codec/
│   │   ├── g711.go                     PCMU/PCMA encode + decode lookup tables
│   │   └── resample.go                 8↔16 kHz (linear interp / 2-tap boxcar)
│   ├── pipecat/
│   │   ├── wire.go                     hand-rolled protobuf wire codec
│   │   └── client.go                   per-call WebSocket client to the worker
│   ├── call/
│   │   └── manager.go                  per-call orchestrator (SIP + RTP + WS)
│   └── api/
│       └── server.go                   REST control surface (health, hangup, ...)
├── proto/frames.proto                  documentation copy of Pipecat's schema
├── Dockerfile                          two-stage build → distroless static
├── go.mod
└── go.sum
```

LoC breakdown (Phase A complete): roughly 1.9 kLoC of Go.


## Per-phase scope

| Phase | Functionality | Status |
|---|---|---|
| **A** | inbound INVITE → G.711 → WS, BYE, REST health/hangup | **shipped** |
| **B** | outbound originate (`POST /v1/calls`), blind REFER, BYE on hangup | **shipped** |
| **C** | warm transfer (LiveKit-parity TransferAgent + media-relay bridge) | **shipped** |
| **D** | jitter buffer with sequence-aware ordering + silence-fill PLC | **shipped** |
| E | Opus + G.722 codec support | **deferred** — see below |
| **F** | DTMF (RFC 4733) inbound to worker | **shipped** |
| F.2 | hold/unhold re-INVITE handling | deferred |
| **G** | TLS for SIP signalling | **shipped** |
| G.2 | SRTP with SDES key exchange | deferred |

Each phase is independently runnable. Phases B and C unlock the
existing function-tool surface (`hangup`, `transfer`,
`transfer_status`) end-to-end via the bridge.

### Why E is deferred

The only mature pure-Go Opus codec ([pion/opus](https://github.com/pion/opus))
ships **only a decoder** as of v0.0.x — there's no encoder, so we
can't put PCM-from-Pipecat back on the wire as Opus. Full-duplex Opus
support requires `cgo` + `libopus`, which would lose the distroless
static base image and triple the container's runtime footprint. Given
that:

- The upstream B2BUA handles carrier-side codec negotiation; the
  bridge-to-B2BUA leg is typically G.711.
- G.722 (the other wideband codec in scope) has only small,
  unmaintained Go libraries.

We've left the codec surface at PCMU + PCMA + RFC 4733 telephone-event
for now. The codec interface in `internal/codec/` is set up so adding
Opus or G.722 later (whether pure-Go or cgo) is a single-file change.
Tracked as a follow-up when one of:

1. pion/opus ships an encoder, **or**
2. the operational topology adds direct-carrier paths that need wideband, **or**
3. we accept the cgo trade-off explicitly.

### Why F.2 (hold/unhold) is deferred

sipgo's dialog API doesn't currently expose a clean re-INVITE handler
on the `DialogServerSession` — re-INVITEs arrive at the same
`OnInvite` callback as initial INVITEs, and the discriminator (matching
the To-tag against an existing dialog) requires extra plumbing the
team is iterating on upstream. The audio-side handling (mirror
direction, inject silence) is straightforward; what's not is the
dialog routing. Will revisit when sipgo has a documented re-INVITE
hook or when we have a concrete hold/unhold use case to drive the
implementation.

### Why G.2 (SRTP) is deferred

SDES + pion/srtp integration is a meaningful chunk: SDP profile
swap to `RTP/SAVP`, key generation, per-direction `srtp.Context`,
encrypt/decrypt wrappers in the RTP send/recv paths, plus key rotation
on re-INVITE. The TLS-only Phase G already addresses the signalling
attack surface (no SIP credentials or call metadata on the wire); the
RTP path stays plaintext but is intended to live on a trusted LAN
between B2BUA and bridge. SRTP becomes interesting if the bridge ever
needs to sit on an untrusted network segment, at which point we wire
it as Phase G.2.


## Wire contract with the worker

**Connection direction.** sipbridge is the WS *client*; the worker is
the WS *server*. The bridge dials `ws://<worker>:8082/sipbridge/agent/<session_id>`
after accepting the SIP INVITE; the worker accepts the WS and runs the
Pipecat pipeline on it.

**Audio framing.** Pipecat protobuf at 16 kHz mono, `AudioRawFrame` only
in both directions. Sample rate is hard-coded because the worker's
`WebsocketServerTransport` reads it from the inbound frame and resamples
internally if needed — keeping our bridge at 16 kHz means no second
resample inside the worker.

**SIP→WS metadata.** The bridge attaches every SIP-derived header the
worker's agent-lookup chain might need:

| Header | Meaning |
|---|---|
| `X-Sipbridge-Call-ID` | SIP Call-ID (or X-Aplisay-Call-Id if present) |
| `X-Sipbridge-From` | full URI from the INVITE's From header |
| `X-Sipbridge-To` | full URI from the INVITE's To header |
| `X-Aplisay-Trunk` | passthrough from the upstream B2BUA |
| `X-Aplisay-PhoneRegistration` | passthrough from the upstream B2BUA |
| `X-Aplisay-Call-Id` | passthrough from the upstream B2BUA |
| `X-Lk-RealIp` | passthrough — B2BUA path's gateway IP |
| `X-Lk-Transport` | passthrough — B2BUA path's transport |

The worker's `_sipbridge_resolve_agent_from_headers` parses these and
runs the same `phone_registration → trunk+number → number` lookup chain
as the Daily / FreeSWITCH / voiceblender ingresses.

**Call control.** Worker → bridge via REST:

| Verb | Endpoint | Body | Effect |
|---|---|---|---|
| GET | `/health` | — | liveness + active-call count |
| DELETE | `/v1/calls/{id}` | — | BYE + media teardown |
| POST | `/v1/calls` | `{destination, caller_id, agent_ws_session_id, custom_headers, metadata}` | outbound INVITE; returns `{ok, call_id}` once 200 OK arrives and the worker WS is wired |
| POST | `/v1/calls/{id}/transfer` | `{target, mode, monitor_dtmf?, tap_audio?}` where mode ∈ `"blind"`, `"bridged"`, `"attended"`, `"dial_bridge"` | blind = in-dialog REFER on `id`; bridged = media-relay between `id` and `target` (a previously-consulted call_id); attended = REFER-with-Replaces to the consult dialog; dial_bridge = dial `target` as an agent-less leg and relay. `monitor_dtmf` (bridged/dial_bridge only) keeps `id`'s worker WS open as a control channel and surfaces target-leg DTMF on it; `tap_audio` additionally streams a decoded stereo copy of the bridge for transcription — see below |
| POST | `/v1/calls/{id}/consult` | `{destination, caller_id, agent_ws_session_id, ...}` | dials a second leg as a consult; returns `{ok, consult_call_id}` once the bot WS is wired |
| POST | `/v1/calls/{id}/unbridge` | `{agent_ws_session_id, custom_headers?}` | human-to-agent takeover finalise: BYE the bridged peer leg, dismantle the relay, and re-attach `id` to a fresh worker agent WS at `/sipbridge/agent/{agent_ws_session_id}` |
| POST | `/v1/calls/{id}/dtmf` | `{digits}` (over `0-9`, `*`, `#`) | play `digits` to the far end as out-of-band RFC 4733 telephone-event RTP; the bridge synthesises the tones on `id`'s own SSRC and plays them on a background goroutine. Drives the `send_dtmf` builtin — see [send-dtmf.md](send-dtmf.md) |

A shared `SIPBRIDGE_API_TOKEN` Bearer guards all endpoints except
`/health`. Empty token disables auth (dev only).

**Bridge → worker via WebSocket** (Pipecat protobuf frames):

| Direction | Frame type | Notes |
|---|---|---|
| bridge → worker | `AudioRawFrame` | 16 kHz mono s16le PCM, 20 ms chunks |
| bridge → worker | `MessageFrame` | small JSON payloads — currently DTMF events only: `{"type":"dtmf","digit":"5","duration_ms":120,"call_id":"..."}` |
| worker → bridge | `AudioRawFrame` | 16 kHz mono s16le PCM, downsampled + G.711-encoded on the bridge before egress |

DTMF events fire once per key-press (the bridge collects RFC 4733
event packets and emits a single MessageFrame on the end-of-event
flag). The worker's Pipecat pipeline can consume them via a custom
processor or by hooking the transport's `MessageFrame` callback.

**Monitored bridges (human-to-agent transfers).** When a bridged
transfer is placed with `monitor_dtmf: true`
(`options.bridgedTransferToAgent` — see
[`call-transfers.md`](call-transfers.md#human-to-agent-transfers-bridgedtransfertoagent)),
the original leg's worker WS is *kept open* across the bridge as a
control-only channel: no audio frames flow in either direction (bot
audio is dropped while a relay is installed), but DTMF detected on the
**peer (transfer-target) leg** is delivered on it as

```json
{"type":"dtmf","digit":"1","duration_ms":120,"call_id":"<this leg>","peer_call_id":"<target leg>","source":"transfer_target"}
```

with end-of-event retransmissions deduplicated. The worker's monitor
loop (`pipecat_aplisay/bridged_transfer.py`) matches configured
sequences and POSTs `/v1/calls/{id}/unbridge` to complete the takeover;
the bridge then closes the monitor WS and dials
`/sipbridge/agent/{agent_ws_session_id}` for the new agent session. A
worker WS closing while a call is bridged never tears the call down —
the bridged pair lives until either side BYEs (at which point the
bridge BYEs the peer leg too).

**Transcription tap (`tap_audio`).** With
`options.bridgedTransferTranscribe` set, the transfer additionally
carries `tap_audio: true` and the bridge streams a decoded stereo copy
of the relay on the same kept-open WS as two-channel `AudioRawFrame`s
(16 kHz s16le; **left = caller, right = transfer target** — see
`internal/call/tap.go`). The RTP fast path between the humans is
untouched: the tap is a per-packet decode into a 20 ms mixer that drops
rather than back-pressures when the WS is slow, and frames are skipped
entirely while both sides are silent. The worker splits the channels
into one STT stream per human (`pipecat_aplisay/bridge_transcript.py`)
and logs the labelled finals against the bridged-segment call record.


## Operations

### Compose profile

Same profile shape as the other ingresses:

```bash
# Foreground-worker dev:
docker compose -f docker-compose.dev.yml --profile sipbridge up --build
SIP_GATEWAY=sipbridge uv run python -m pipecat_aplisay

# Container-everywhere production:
docker compose --profile sipbridge up -d
```

The bridge binds the host's UDP/5060 + 10000-20000 by default — same
range as voiceblender and FreeSWITCH, so the profiles are mutually
exclusive.

### Required env vars (sipbridge ingress)

| Variable | Default | Owner | Purpose |
|---|---|---|---|
| `SIP_GATEWAY` | `freeswitch` | worker | `sipbridge` to wire `SipBridgeSipGateway` at startup. Must match `COMPOSE_PROFILES`. |
| `COMPOSE_PROFILES` | `freeswitch` | docker | `sipbridge` to start the sipbridge container. |
| `SIPBRIDGE_SIP_SIGNAL_IP` | none (required) | bridge | IP advertised in Contact/Via — the upstream B2BUA's `Route-Set`. |
| `SIPBRIDGE_MEDIA_IP` | = signal IP | bridge | IP advertised in SDP `c=`/`m=`. |
| `SIPBRIDGE_SIP_SIGNAL_PORT` | `5060` | bridge | SIP UDP listener port. |
| `SIPBRIDGE_RTP_PORT_MIN/MAX` | `10000`-`20000` | bridge | Even-numbered RTP port range. |
| `SIPBRIDGE_WORKER_WS_BASE` | `ws://pipecat-worker:8082` | bridge | Where to dial the worker. Use `ws://host.docker.internal:8082` on macOS/Windows dev. |
| `SIPBRIDGE_API_BIND_ADDR` | `:8090` | bridge | REST control port. |
| `SIPBRIDGE_API_TOKEN` | (empty) | both | Bearer for REST control. Optional in dev. |
| `SIPBRIDGE_BASE_URL` | `http://sipbridge:8090` | worker | Where the worker reaches the bridge's REST. With host networking: `http://127.0.0.1:8090`. |
| `SIPBRIDGE_TLS_CERT_FILE` | (empty) | bridge | PEM-encoded SIPS certificate. Setting this + the key file activates the TLS listener. |
| `SIPBRIDGE_TLS_KEY_FILE` | (empty) | bridge | PEM-encoded SIPS private key. |
| `SIPBRIDGE_SIP_TLS_PORT` | `5061` | bridge | TCP port for SIPS. Ignored if cert/key files are unset. |


### What stays in the worker (vs the bridge)

| Concern | Owner |
|---|---|
| SIP signalling (INVITE / BYE / REFER / NOTIFY) | sipbridge |
| RTP media termination, codec encode/decode, resample | sipbridge |
| Pipecat protobuf framing on the WS | sipbridge |
| Function-tool callable surface (hangup, transfer, ...) | worker (proxies to bridge REST) |
| Transfer state machine | worker |
| Greeting orchestration (text / instructions / muting) | worker |
| Recording (AES-GCM encrypted OGG/Opus → GCS) | worker |
| Transcript forwarding | worker |
| Realtime model bindings (OpenAI Realtime, Gemini Live, Ultravox) | worker |
| Pipeline-mode bindings (STT/LLM/TTS) | worker |
| Concurrency / fallback chain | worker |
| Browser path (`/webrtc/offer`) | worker — unrelated, unaffected |


### Smoke tests

**Phase A — inbound**

```bash
# 1. Build + boot the bridge
cd agents/pipecat
docker build -f sipbridge/Dockerfile -t sipbridge:dev ../..

docker run --rm -d --name sipbridge-dev \
  -p 8090:8090 -p 5060:5060/udp -p 10000-20000:10000-20000/udp \
  -e SIPBRIDGE_SIP_SIGNAL_IP=127.0.0.1 \
  -e SIPBRIDGE_WORKER_WS_BASE=ws://host.docker.internal:8082 \
  -e SIPBRIDGE_LOG_LEVEL=debug \
  sipbridge:dev

# 2. Verify health
curl http://127.0.0.1:8090/health
# → {"active_calls":0,"ok":true}

# 3. Start the worker pointed at the bridge
SIP_GATEWAY=sipbridge \
  SIPBRIDGE_BASE_URL=http://127.0.0.1:8090 \
  uv run python -m pipecat_aplisay

# 4. INVITE the bridge from a softphone (e.g. baresip):
#    sip:+44...@127.0.0.1:5060
#    The bridge dials the worker's /sipbridge/agent/<call-id> WS,
#    audio flows end-to-end.

# 5. Tear down
docker stop sipbridge-dev
```

**Phase B — outbound originate**

```bash
# Via the worker's dispatch endpoint (same path the JS handler uses
# for production outbound flows):

curl -X POST http://127.0.0.1:8082/dispatch \
  -H "authorization: Bearer $PIPECAT_DISPATCH_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "kind": "outbound",
    "sessionId": "test-out-1",
    "callId": "...",
    "callerId": "+441234567890",
    "calledId": "+441234567891",
    "instanceId": "<existing-instance-id>"
  }'

# Expected:
#  - bridge logs "sip: outbound INVITE answered" on 200 OK
#  - worker logs "call: outbound ready" with rtp_port + ws_url
#  - audio flows; the bot greeting plays into the called party
```

**Phase B — blind REFER**

Trigger the `transfer` function tool from a live call with
`operation="blind"`. Watch the bridge logs for
`sipbridge transfer (blind REFER)` and the carrier-side NOTIFY
sequence. The carrier should drive the new call and BYE us when done.

**Phase C — warm transfer (LiveKit-parity)**

The consultative-transfer flow on sipbridge implements
[`docs/call-transfers.md`](call-transfers.md) byte-for-byte against
the LiveKit reference at `agents/livekit/lib/transfer-handler.ts`. The
bot makes a single `transfer({operation: "consultative", ...})` call;
everything after that is driven by the TransferAgent that sipbridge
spins up on the consult leg.

```
# Bot makes ONE call. transfer() returns immediately with status OK;
# consultation continues in the background.
transfer(
  operation="consultative",
  number="+44C...",
  transferPrompt="You are accepting an urgent call. Conversation: ${parentTranscript}. Decide and call accept_transfer or reject_transfer."
  # (transferPrompt is optional — falls through to agent.options.transferPrompt,
  #  then to the canonical default in agents/pipecat/pipecat_aplisay/transfer_prompts.py)
)
```

What happens behind the scenes:

1. Worker resolves `transferPrompt` (args → `agent.options.transferPrompt`
   → `DEFAULT_TRANSFER_PROMPT_TEMPLATE`).
2. Worker snapshots the parent's chat history from the live
   `LLMContext` and renders it as `> caller: ...` / `> agent: ...`
   lines (matches transfer-handler.ts:599-605).
3. Worker stashes `(parent_session, template, transcript)` on the
   gateway, POSTs `/v1/calls/{id}/consult` to sipbridge, and returns
   from the tool call. Parent transfer_state → `dialling`.
4. Sipbridge dials the third party. On 200 OK it opens the audio WS
   to the worker at `/sipbridge/agent/<consult_session_id>`.
5. Worker WS handler picks up the consult payload, substitutes
   `${parentTranscript}`, builds a **TransferAgent agent dict** —
   same model + LLM provider as the parent, but a bespoke system
   prompt and a restricted function surface
   (`accept_transfer`, `reject_transfer` only).
6. `setup_consult_call` creates a separate persisted `Call` record
   with `parentId` linking to the original + `transferConsultation: true`
   metadata. CallSession is set up with `parent_session` populated so
   the new function-builtins know who to drive.
7. Worker runs the consult bot's pipeline. Parent transfer_state → `talking`.
8. TransferAgent talks to the third party:
   - **`accept_transfer(reason?)`** → POSTs
     `/v1/calls/{parent}/transfer { mode: "bridged", target: <consult> }`
     to sipbridge. Bridge installs media relay, closes both bot WSes,
     A↔C are now talking directly through the bridge. Parent
     transfer_state → `none` ("Transfer completed successfully").
   - **`reject_transfer(reason)`** → DELETEs the consult leg. Parent
     transfer_state → `rejected` with `reason` as description.
   - **Disconnect before decision** → handler's finally clause sets
     parent transfer_state → `rejected` with "Transfer target
     disconnected" (matches transfer-handler.ts:799-800).

Parent bot polls `transfer_status()` to see the outcome.

Expected log sequence:

```
worker: sipbridge transfer (operation=consultative, target=+44C...)
worker: sipbridge consultative: dialing third party
worker: sip: outbound INVITE answered (call_id=<consult>)
worker: call: outbound ready (consult leg)
worker: sipbridge consult: spawning TransferAgent CallSession
TransferAgent (in the consult bot): calls accept_transfer  OR  reject_transfer(reason="...")
worker: consult accept_transfer fired; bridge installed  OR  consult reject_transfer fired; parent state=rejected
```

Verification of LiveKit parity is in
[`agents/pipecat/pipecat_aplisay/transfer_prompts.py`](../agents/pipecat/pipecat_aplisay/transfer_prompts.py):
the `DEFAULT_TRANSFER_PROMPT_TEMPLATE` constant is byte-for-byte
identical to the LiveKit canonical at
`agents/livekit/lib/transfer-handler.ts:615` (926 bytes; SHA-256 prefix
`53c6fe1e`).

### Cross-gateway parity for consultative transfer

The same consultative-transfer contract is implemented identically
across all consult-capable gateways. Shared scaffolding lives in:

- `pipecat_aplisay/sip_gateway/base.py` — `ConsultPayload` dataclass,
  `ConsultStateMixin` (the per-gateway payload + call-id tracking).
- `pipecat_aplisay/call_session.py` — `build_transfer_agent_dict()`
  (TransferAgent agent dict assembly), `setup_consult_call()` (creates
  the consult-side Call record with `parentId` linkage),
  `_builtin_consult_accept/reject` (the accept/reject tool factories).
- `pipecat_aplisay/transfer_prompts.py` — the canonical default
  template + `resolve_transfer_prompt`/`substitute_parent_transcript`/
  `render_parent_transcript`.

Each gateway implements only the gateway-specific seams:

| Capability | sipbridge | voiceblender | freeswitch | daily |
|---|---|---|---|---|
| `_do_consultative` (originate consult leg) | `POST /v1/calls/{id}/consult` | `POST /v1/legs` w/ `agent.agent_id` = our worker WS | `POST /calls/originate` (esl-poller) w/ `channelUuid` = consult session id | hard-error (no multi-room consult yet) |
| `_VbGatewaySession.bridge_with` (media bridge after accept) | `POST /v1/calls/{id}/transfer { mode: "bridged" }` | `POST /v1/rooms` + `POST /v1/rooms/{id}/legs` (room-mixer bridge) | `POST /calls/{uuid}/bridge` (`uuid_bridge` ESL) | n/a (NotImplementedError) |
| Worker WS consult arm | `WS /sipbridge/agent/{session_id}` | `WS /voiceblender/agent/{session_id}` | `WS /freeswitch/audio` (consult discriminator via start.channel_uuid → consult_payload) | n/a |
| `consult_payload` keyed by | bridge call_id (== session_id) | leg_id (== session_id) | channel_uuid (== session_id) | n/a |
| `transferPrompt` resolution | shared (CallSession) | shared (CallSession) | shared (CallSession) | n/a |
| `${parentTranscript}` substitution | shared (transfer_prompts) | shared (transfer_prompts) | shared (transfer_prompts) | n/a |
| Default prompt template | shared (`DEFAULT_TRANSFER_PROMPT_TEMPLATE`) | shared | shared | n/a |
| `accept_transfer` / `reject_transfer` tools | shared (`_builtin_consult_accept/reject`) | shared | shared | n/a |
| Consult Call record with `parentId` | shared (`setup_consult_call`) | shared | shared | n/a |
| Async return semantics | shared (`_on_transfer`) | shared | shared | hard-error (won't reach the async path) |
| `transfer_state` taxonomy | shared (`TransferState`) | shared | shared | shared but only `failed` reachable for consultative |

This means a bot's `transfer({operation: "consultative", ...})` call
behaves identically whichever of the three consult-capable gateways
is active: same prompt resolution chain, same TransferAgent surface,
same accept/reject mechanics, same Call record shape, same
`transfer_state` transitions. Daily gateway raises a clear
`RuntimeError` on consultative (returned as `{status: "FAILED",
reason: "..."}` from the tool call) so bot code can degrade
gracefully.

**Phase F — DTMF**

Press a key on the softphone during a live call. Worker should
receive a `MessageFrame` with JSON
`{"type":"dtmf","digit":"5","duration_ms":..., "call_id":"..."}`.
A custom Pipecat processor on the worker can subscribe to
`MessageFrame` to react.

**Phase G — TLS**

Generate a self-signed cert for local testing:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout sipbridge.key -out sipbridge.crt \
  -subj "/CN=sipbridge.local"

# Mount the cert + key into the container and enable TLS:
docker run ... \
  -v $PWD/sipbridge.crt:/tls/cert.pem:ro \
  -v $PWD/sipbridge.key:/tls/key.pem:ro \
  -e SIPBRIDGE_TLS_CERT_FILE=/tls/cert.pem \
  -e SIPBRIDGE_TLS_KEY_FILE=/tls/key.pem \
  -e SIPBRIDGE_SIP_TLS_PORT=5061 \
  -p 5061:5061/tcp \
  sipbridge:dev

# Bridge logs "sip: listening (TLS)" alongside the UDP listener.
# INVITE from a SIPS-aware peer at sips:test@host:5061 should be
# handled identically to UDP-side INVITE.
```


## Design choices worth knowing about

### Hand-rolled protobuf wire codec

The 5-message Pipecat schema (TextFrame, AudioRawFrame,
TranscriptionFrame, MessageFrame, Frame oneof) has no maps, no enums,
and no nested submessages beyond the outer Frame oneof. A direct
~150-LoC implementation of the protobuf binary format
(`internal/pipecat/wire.go`) is cheaper to maintain than wiring protoc
into the Dockerfile.

The schema is mirrored at `proto/frames.proto` for documentation and
diffing against Pipecat upstream — if a new field lands there, mirror
it into `wire.go` (encoders + decoders) and we're done. Unknown fields
are silently skipped on decode, so forward-compat is automatic up to a
new oneof branch.

### G.711 lookup tables

PCMU and PCMA encode/decode are 256-entry lookup tables computed at
init. One memory access per sample, zero allocations per packet.
Phase E will add Opus (likely cgo-libopus) and G.722 (pure Go via
pion/interceptor).

### 8↔16 kHz resampling

Linear interpolation (upsample) and 2-tap boxcar averaging
(downsample). The G.711 payload is already band-limited to ~3.4 kHz so
a sharper anti-imaging / anti-aliasing filter would buy us nothing
audible. If we add Opus or G.722 (which carry real wideband energy)
we'll want a polyphase FIR here — file that follow-up alongside the
codec work.

### Distroless static base image

CGO disabled, no system libraries, ~25 MB final image. The Pipecat
protobuf framing is pure Go, sipgo is pure Go, pion/rtp is pure Go.
Phase E's Opus integration will likely need cgo+libopus — at that
point the runtime base switches to `gcr.io/distroless/base`.


## Known limitations / follow-ups

What's **shipped** as of the latest sync (Phases A–D, F-DTMF, G-TLS):

- Inbound + outbound 1:1 calls with G.711 (PCMU/PCMA).
- Worker-initiated hangup via REST → SIP BYE.
- Blind transfer (in-dialog REFER).
- Warm transfer with consult leg + media-relay bridge.
- Per-call 60 ms jitter buffer with silence-fill PLC.
- RFC 4733 telephone-event DTMF surfaced to worker as MessageFrame.
- TLS (SIPS) signalling listener alongside UDP.

What's **deferred** to follow-ups:

- **Opus / G.722 codecs (Phase E)** — pion/opus only ships a decoder
  today, so full-duplex Opus needs cgo+libopus and would lose the
  distroless static base. G.722 has no maintained pure-Go library.
  Tracked at the codec-interface boundary; one-file change to add
  once we have a viable codec library.
- **Hold/unhold (re-INVITE) handling (Phase F.2)** — sipgo's
  re-INVITE routing is the blocker. The SDP-direction parsing is
  already in place; what's missing is the dialog-state plumbing to
  route re-INVITEs to the existing dialog's response path rather
  than the initial-INVITE handler.
- **SRTP (Phase G.2)** — designed for trusted-LAN deployment for now.
  Adding SDES + pion/srtp wrappers is mechanical but non-trivial
  (~300-500 LoC + per-direction context management). Worth doing if
  the bridge ever sits on an untrusted segment.
- **Cross-family codec transcoding (mu↔A) on bridged transfer** —
  the relay path forwards codec payloads byte-for-byte. If A
  negotiated PCMU and C negotiated PCMA the relay would mis-decode.
  Currently rejected with an explicit error
  (`"call: bridge: codec mismatch"`); transcoding would be ~30 LoC
  in `internal/call/manager.go:onRTPPayload` peer path using the
  existing codec tables.
- **Cert hot-reload for TLS** — certs are loaded once at startup.
  A SIGHUP / file-watch reloader is a quality-of-life follow-up.


## Comparison: choosing between sipbridge, voiceblender, and FreeSWITCH

All three ingresses are first-class and selectable via `SIP_GATEWAY` +
compose profile. The decision matrix:

|  | sipbridge | voiceblender | FreeSWITCH |
|---|---|---|---|
| Lines of code we own | ~3.6 kLoC | 0 | 0 |
| Maturity | early — phases A–D + parts of F & G shipped | v0.6.0 (May 2026) | decades |
| Native blind REFER | yes (Phase B) | yes | yes |
| Native warm transfer (consult + bridge) | yes (Phase C v1) | yes | yes |
| Native recording (S3) | n/a — worker owns | yes (unencrypted) | n/a |
| Codecs (today) | PCMU + PCMA + telephone-event 101 | PCMU + PCMA + G.722 + Opus | everything |
| TLS for SIP | yes (Phase G) | yes | yes |
| SRTP | follow-up (G.2) | yes | yes |
| DTMF in-band → worker | yes (Phase F) | yes | yes |
| Hold/unhold re-INVITE | follow-up (F.2) | yes | yes |
| Container size | ~25 MB (distroless static) | ~80 MB | several hundred MB + esl-poller sidecar |
| Carrier compat | DIY (bugs are ours) | inherited from voiceblender's testing | inherited from FreeSWITCH's |
| Operational footprint | 1 container, host net, 5060 UDP + (5061 TCP if TLS) + 10k-20k UDP + 8090 TCP | 1 container, host net, 5060 + 10k-20k UDP + 8080 TCP | 2 containers (FS + esl-poller), host net, full SIP stack |
| Maintainer cadence | ours | upstream | upstream |

The right pick depends on the deployment:

- **Production stack today**: FreeSWITCH. Battle-tested.
- **Self-managed without operational burden of FS**: voiceblender — but
  carries the project-immaturity risk.
- **Smallest possible footprint, full control**: sipbridge. As Phase B
  and C land it becomes a candidate for production replacement of
  FreeSWITCH for the agent path; the upstream B2BUA continues to do
  the heavy SIP carrier-side work.


## Code map

| File | What |
|---|---|
| `agents/pipecat/sipbridge/cmd/sipbridge/main.go` | entrypoint; spawns UDP + (optional) TLS SIP + REST listeners |
| `agents/pipecat/sipbridge/internal/config/config.go` | env-var loader incl. TLS cert/key paths |
| `agents/pipecat/sipbridge/internal/sip/server.go` | sipgo UAS — INVITE/ACK/BYE, **outbound Invite (Phase B)**, **REFER blind (Phase B)**, **TLS listener (Phase G)** |
| `agents/pipecat/sipbridge/internal/sip/sdp.go` | SDP offer parse + answer build + **outbound offer (Phase B)**; PT 101 telephone-event always offered |
| `agents/pipecat/sipbridge/internal/rtp/session.go` | RTP UDP socket + framing; sequence number plumbed to caller |
| `agents/pipecat/sipbridge/internal/rtp/jitter.go` | **Phase D**: jitter buffer with silence-fill PLC |
| `agents/pipecat/sipbridge/internal/rtp/dtmf.go` | **Phase F**: RFC 4733 telephone-event parser |
| `agents/pipecat/sipbridge/internal/codec/g711.go` | PCMU/PCMA tables |
| `agents/pipecat/sipbridge/internal/codec/resample.go` | 8↔16 kHz |
| `agents/pipecat/sipbridge/internal/pipecat/wire.go` | hand-rolled protobuf encoder/decoder |
| `agents/pipecat/sipbridge/internal/pipecat/client.go` | per-call WS client; `SendAudio` + `SendMessage` |
| `agents/pipecat/sipbridge/internal/call/manager.go` | per-call orchestrator; **Originate (Phase B)**, **Consult + BridgeRelay (Phase C)**, **jitter release loop (Phase D)**, **DTMF handler (Phase F)** |
| `agents/pipecat/sipbridge/internal/api/server.go` | REST control: `/health`, `DELETE /v1/calls/{id}`, **`POST /v1/calls`**, **`POST /v1/calls/{id}/transfer`**, **`POST /v1/calls/{id}/consult`** |
| `agents/pipecat/sipbridge/Dockerfile` | two-stage build → distroless static |
| `agents/pipecat/sipbridge/proto/frames.proto` | reference copy of Pipecat schema |
| `agents/pipecat/pipecat_aplisay/sip_gateway/sipbridge_gateway.py` | `SipBridgeSipGateway` — Phase B/C transfer modes, consult tracking |
| `agents/pipecat/pipecat_aplisay/worker.py` | `WS /sipbridge/agent/{session_id}` route — inbound + outbound + Phase C consult branches |
| `agents/pipecat/docker-compose.yml` | sipbridge profile (build from source) |
| `agents/pipecat/docker-compose.dev.yml` | sipbridge profile for dev |
| `agents/pipecat/deploy/gcp/docker-compose.gcp.yml` | sipbridge profile for GCP |
| `agents/pipecat/deploy/gcp/cloudbuild*.yaml` | sipbridge image build step |
| `agents/pipecat/deploy/gcp/env-example-*` | `SIPBRIDGE_*` env knobs |
