# Aplisay Pipecat agent

Pipecat-based voice-agent stack that fulfils the same contract as the LiveKit
worker but is independent of LiveKit. The contract is documented in
[../../docs/livekit-agent-architecture.md](../../docs/livekit-agent-architecture.md).

## Architecture

Three containers, deployable together via `docker-compose.yml`:

```
                       ┌─────────────────────┐
                       │      FreeSWITCH     │
   SIP / RTP ──────────┤  + mod_audio_stream │
                       └────────┬────────────┘
                          ESL │      │ WS (L16 PCM + JSON events)
                              │      │
                       ┌──────▼──┐ ┌─▼────────────────────┐
                       │ esl-    │ │   pipecat-worker     │
                       │ poller  │ │   (Python / FastAPI) │
                       │  (TS)   │◀┤                      │
                       │         │ │  - /dispatch         │
                       │ HTTP    │ │  - /freeswitch/audio │
                       │ control │ │  - /freeswitch/events│
                       │ API +   │ │  - /webrtc/offer     │
                       │ event   │ │  - /daily/dialin     │
                       │ webhook │ │                      │
                       └─────────┘ └──────┬───────────────┘
                                          │ REST callbacks
                                          ▼
                                  llm-agent (agent-db)
```

- **FreeSWITCH** terminates SIP and forks media to the worker over a WebSocket
  via [voxcom-us/mod_audio_stream](https://github.com/voxcom-us/mod_audio_stream).
  L16 PCM 16 kHz mono in both directions, plus JSON metadata events.
- **esl-poller** owns the ESL socket. It is an extension of the
  [aplisay-b2bua esl-poller](https://github.com/aplisay/aplisay-b2bua/tree/main/esl-poller)
  with two additions:
  - An HTTP **call-control API** (`/calls/originate`,
    `/calls/:uuid/transfer`, `/calls/:uuid/hangup`) the Python worker calls.
  - A **channel-event webhook** that posts FreeSWITCH `CHANNEL_HANGUP` /
    `CHANNEL_BRIDGE` / `CHANNEL_ANSWER` to the worker.

  The original gateway-state poller is preserved behind
  `GATEWAY_POLL_ENABLED=true` so the same binary still works in the
  aplisay-b2bua deployment.
- **pipecat-worker** is a Python FastAPI service running Pipecat pipelines.
  It is gateway-agnostic above the `SipGateway` abstraction; `SIP_GATEWAY=freeswitch`
  selects the FreeSWITCH implementation (also supports `daily` for the
  hosted-gateway path documented separately).

Browser / in-band WebRTC clients connect peer-to-peer via Pipecat's
`SmallWebRTCTransport`, independent of FreeSWITCH.

## Endpoints

Worker (Python):

- `POST /dispatch` — outbound dispatch from the JS handler. Bearer-auth with
  `PIPECAT_DISPATCH_TOKEN`. POSTs an `originate` to the esl-poller; FreeSWITCH
  dials out and the resulting channel opens a WebSocket to `/freeswitch/audio`.
- `WS /freeswitch/audio` — long-lived WS per call. The first text frame is
  mod_audio_stream's `start` event carrying the section-6 wire headers
  (`X-Aplisay-Trunk`, `X-Aplisay-PhoneRegistration`, `X-Lk-RealIp`,
  `X-Lk-Transport`, `X-Aplisay-Call-Id`) as channel variables.
- `POST /freeswitch/events` — channel-level events forwarded by esl-poller.
- `POST /webrtc/offer` — browser SDP offer; signed-token gated.
- `POST /daily/dialin` — used only when `SIP_GATEWAY=daily`.

esl-poller (TS):

- `POST /calls/originate`
- `POST /calls/:uuid/transfer`
- `POST /calls/:uuid/hangup`
- `GET  /health`

## Running locally

```bash
cd agents/pipecat
cp .env.example .env
# edit .env — fill in tokens and provider keys
docker compose up --build
```

The compose file uses host networking so RTP port pinning is straightforward
and FreeSWITCH-to-worker / worker-to-poller traffic stays on `127.0.0.1`. For
non-host deployments expose ports explicitly and use service DNS names in the
URL env vars.

## Environment

The container env vars are summarised in `.env.example`. Highlights:

- `SIP_GATEWAY=freeswitch` selects this stack. (`daily` switches to the hosted
  gateway implementation.)
- `ESL_POLLER_URL` / `ESL_POLLER_TOKEN` connect the worker to esl-poller.
- `PIPECAT_WS_URL` is the `audio_stream` target FreeSWITCH dials into; the
  dialplan expands it via env var substitution.
- `WORKER_EVENT_WEBHOOK` is where esl-poller POSTs channel events.
- `PIPECAT_DISPATCH_TOKEN` / `PIPECAT_JOIN_SECRET` are shared with the JS
  handler in `lib/handlers/pipecat.js`.
- `SERVICE_BASE_URI` / `SHARED_API_TOKEN` reach the llm-agent agent-db REST API
  (section 8 of the architecture doc).

## Where things live

- `freeswitch/` — Dockerfile (extends `rjp44/b2bua-freeswitch:latest` with
  `mod_audio_stream`), conf (dialplan, sofia profile, switch.conf), entrypoint.
- `esl-poller/` — TypeScript service; `src/index.ts` is the original
  aplisay-b2bua poller (gated by `GATEWAY_POLL_ENABLED`), `src/call-api.ts` is
  the new call-control surface.
- `pipecat_aplisay/` — Python worker.
  - `sip_gateway/freeswitch_gateway.py` — HTTP client to esl-poller, plus
    `register_inbound_session` to match outbound originates against incoming
    WS connections.
  - `serializers/freeswitch_audio_stream.py` — `FrameSerializer` for
    mod_audio_stream's wire protocol.
  - `worker.py` — FastAPI endpoints incl. the WS handler at `/freeswitch/audio`.
- `docker-compose.yml` — three-container stack.

## Known contract gaps (vs section 6 of the architecture doc)

FreeSWITCH gives back the full SIP wire-header story that Daily abstracted:
`X-Aplisay-Trunk` / `X-Aplisay-PhoneRegistration` / `X-Lk-RealIp` /
`X-Lk-Transport` are preserved as channel variables and forwarded in
mod_audio_stream's start event. `canRefer` vs blind-bridge selection per
section 6.7 works end-to-end (`uuid_deflect` for REFER,
`originate + bridge` for blind-bridge). Consultative transfer remains a
follow-up: the gateway interface supports it but the runtime still degrades
the accept-path to blind-bridge (section 6.10).

Recording (section 9.2) is not yet wired — to land via `mod_record` or
`audio_stream`-side capture.

## Pipeline registry

Single source of truth for which model IDs run in pipeline mode:
[`pipecat_aplisay/pipeline_model_ids.py`](pipecat_aplisay/pipeline_model_ids.py).
The JS server reads the same set from `lib/models/pipecat.js`; keep them in
sync until they're unified via a generated manifest.
