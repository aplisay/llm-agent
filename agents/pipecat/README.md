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

Two layouts are available:

- **`docker-compose.yml`** — full three-container stack, everything inside
  Docker. Closest to production.
- **`docker-compose.dev.yml`** — FreeSWITCH and esl-poller in containers, the
  Python worker on the **host in the foreground** (live reload, tracebacks,
  easy debugger attach).

### Full container stack

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

### Dev stack (worker on host)

`docker-compose.dev.yml` brings up FreeSWITCH and esl-poller only. The worker
runs in your terminal foreground via `uv`. Two terminals; in the first:

```bash
cd agents/pipecat
cp .env.example .env                          # one-off — populate tokens etc.
docker compose -f docker-compose.dev.yml up --build
```

…in the second:

```bash
cd agents/pipecat
uv sync                                       # one-off
# Load the same env file the containers use, then run the worker.
set -a; source .env; set +a
export SIP_GATEWAY=freeswitch
export ESL_POLLER_URL=http://127.0.0.1:4001
export PORT=8082
uv run python -m pipecat_aplisay
```

Stop the worker with Ctrl-C. Stop the containers with `docker compose -f
docker-compose.dev.yml down` from the first terminal.

**Networking — Linux**: nothing else required. `network_mode: host` shares the
host's loopback, so `127.0.0.1` resolves the same everywhere — FreeSWITCH
dials `ws://127.0.0.1:8082/freeswitch/audio`, esl-poller POSTs to
`http://127.0.0.1:8082/freeswitch/events`, the worker calls
`http://127.0.0.1:4001/calls/...`. All on the same loopback.

**Networking — macOS / Windows (Docker Desktop)**: containers share the
Docker VM's loopback, not the host's. You need two overrides in `.env` (or
exported into your shell before `docker compose up`) so the containers reach
the host worker via the Docker-Desktop bridge:

```bash
export PIPECAT_WS_URL=ws://host.docker.internal:8082/freeswitch/audio
export WORKER_EVENT_WEBHOOK=http://host.docker.internal:8082/freeswitch/events
```

The reverse direction (worker → esl-poller) keeps working because
`network_mode: host` on Docker Desktop exposes container-listening ports on
the host's `localhost`, so `ESL_POLLER_URL=http://127.0.0.1:4001` is correct
unchanged.

A softphone or SIP trunk wanting to reach FreeSWITCH dials the **host's
IP/hostname**, not `localhost` — Docker Desktop's host-network bridge maps
inbound 5060/UDP to the FreeSWITCH container.

### Required environment variables for the host-side worker

`agents/pipecat/.env` (loaded into the shell via `set -a; source .env; set +a`)
should include at minimum:

| Var                     | Why                                                                   |
| ----------------------- | --------------------------------------------------------------------- |
| `CALL_API_TOKEN`        | Shared bearer between worker and esl-poller; must match container env |
| `PIPECAT_DISPATCH_TOKEN`| Bearer the JS llm-agent handler uses to dispatch outbound calls       |
| `PIPECAT_JOIN_SECRET`   | HMAC secret used to verify `/webrtc/offer` join tokens                |
| `SERVICE_BASE_URI`      | Base URL of the llm-agent REST server (agent-db callbacks)            |
| `SHARED_API_TOKEN`      | `x-shared-token` value for the agent-db API                           |
| `OPENAI_API_KEY`, etc.  | Provider keys for whichever models you exercise                       |

Plus a small set the worker invocation needs specifically:

| Var                | Value                              | Purpose                                          |
| ------------------ | ---------------------------------- | ------------------------------------------------ |
| `SIP_GATEWAY`      | `freeswitch`                       | Selects the FreeSWITCH gateway                   |
| `ESL_POLLER_URL`   | `http://127.0.0.1:4001`            | Where the worker calls the call-control API     |
| `ESL_POLLER_TOKEN` | _(same as `CALL_API_TOKEN`)_       | Bearer for that API                              |
| `WORKER_EVENT_TOKEN` | _(same as `CALL_API_TOKEN`)_     | Bearer the worker requires on `/freeswitch/events` |
| `PORT`             | `8082`                             | Port the worker listens on (FreeSWITCH dials it)|

On the **llm-agent server side** (different process, almost certainly running
in another terminal), point it at the dev worker:

```bash
# in the llm-agent process's environment
export PIPECAT_WORKER_URL=http://127.0.0.1:8082
export PIPECAT_PUBLIC_URL=http://127.0.0.1:8082
export PIPECAT_DISPATCH_TOKEN=<same value as above>
export PIPECAT_JOIN_SECRET=<same value as above>
```

`PIPECAT_PUBLIC_URL` is the origin a browser will hit when joining a WebRTC
session — for local dev with the frontend on the same machine, `127.0.0.1`
is fine; for a tunnelled-in remote browser, set it to the public origin
(ngrok URL, LAN IP, etc.).

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

Recording (section 9.2) is wired via Pipecat's `AudioBufferProcessor`
(`num_channels=2`, user-left / bot-right). PCM is streamed to a local temp
file during the call, encoded to Opus/OGG with ffmpeg on session shutdown,
encrypted in AES‑256‑GCM, and uploaded to GCS. The on-wire contract is
shared with the LiveKit agent — see
[`lib/recording/CONTRACT.md`](../../lib/recording/CONTRACT.md). Implementation
lives in [`pipecat_aplisay/recording/`](pipecat_aplisay/recording/);
enable per agent via `agent.options.recording.enabled` (with instance-level
override) and optionally supply `agent.options.recording.key` for
client-side decrypt.

## Pipeline registry

Single source of truth for which model IDs run in pipeline mode:
[`pipecat_aplisay/pipeline_model_ids.py`](pipecat_aplisay/pipeline_model_ids.py).
The JS server reads the same set from `lib/models/pipecat.js`; keep them in
sync until they're unified via a generated manifest.
