# Aplisay Pipecat agent

Pipecat-based voice-agent worker that fulfils the same contract as the LiveKit
worker but is independent of LiveKit. The contract is documented in
[`docs/livekit-agent-architecture.md`](../../docs/livekit-agent-architecture.md);
this README is the operator's guide for this directory.

## What it is

A gateway-agnostic Python worker (`pipecat_aplisay/`) plus a set of pluggable
SIP ingresses. The worker handles model/voice integration, tool dispatch,
transfer state, recording and REST callbacks to the llm-agent agent-db; the
ingress handles SIP signalling and media. They meet at the `SipGateway`
abstraction (`pipecat_aplisay/sip_gateway/base.py`), selected at startup with
`SIP_GATEWAY=daily|freeswitch|voiceblender|sipbridge`.

```
                ┌──────────────────────────────────────────────────────────┐
                │                       SIP ingress                        │
   SIP / RTP ───┤   one of: freeswitch+esl-poller │ voiceblender │         │
                │            sipbridge            │   Daily.co            │
                └────────────────────────────┬─────────────────────────────┘
                                             │  audio WS + call-control
                                             ▼
                                ┌────────────────────────┐
                                │   pipecat-worker       │
                                │   (Python / FastAPI)   │
                                │                        │
                                │   SipGateway abstraction
                                │   pipelines, tools,    │
                                │   recording, transfers │
                                └─────────────┬──────────┘
                                              │  REST callbacks
                                              ▼
                                      llm-agent (agent-db)
```

Browser / in-band WebRTC clients connect peer-to-peer via Pipecat's
`SmallWebRTCTransport` (`POST /webrtc/offer`), independent of the SIP path.

### Ingress options

| Gateway | SIP termination | Call control | Audio WS protocol | Footprint |
|---|---|---|---|---|
| `daily` | Daily.co (hosted) | Daily SDK | Daily mediasoup | none on host |
| `freeswitch` | FreeSWITCH (self-hosted) | ESL via `esl-poller` sidecar | L16 PCM + JSON (`FreeSwitchAudioStreamSerializer`) | 3 containers, ~hundreds of MB |
| `voiceblender` | [Voiceblender](https://github.com/voiceblender/voiceblender) (self-hosted) | REST + VSI WS | Pipecat protobuf | 1 container, ~80 MB |
| `sipbridge` | sipbridge — in-tree Go UAS (`sipbridge/`) | REST + WS request headers | Pipecat protobuf | 1 distroless container, ~25 MB |

The worker is the same binary in every case; only the gateway implementation
and the compose profile change.

## Running it

Four compose profiles, one per ingress, sharing the same `pipecat-worker`
container:

```bash
cd agents/pipecat
cp env-example .env        # populate tokens, provider keys, EXT_IP_ADDRESS
docker compose --profile freeswitch   up --build   # or
docker compose --profile voiceblender up --build   # or
docker compose --profile sipbridge    up --build   # or
docker compose --profile daily        up --build
```

`docker-compose.yml` is the production-shaped layout (everything in
containers, host networking so RTP port pinning is straightforward). The
profile sets `SIP_GATEWAY` on the worker for you.

### Dev: worker on the host

`docker-compose.dev.yml` brings up only the SIP ingress containers; the
Python worker runs in your terminal foreground for live reload and easy
debugger attach. Same profiles:

```bash
# one terminal — ingress only
docker compose -f docker-compose.dev.yml --profile freeswitch up --build

# second terminal — worker on host
cd agents/pipecat
uv sync                                # one-off
set -a; source .env; set +a
SIP_GATEWAY=freeswitch PORT=8082 uv run python -m pipecat_aplisay
```

Swap `freeswitch` for `voiceblender` or `sipbridge` to dev against a
different ingress.

**macOS / Windows networking caveat.** Docker Desktop's `network_mode: host`
shares the Docker VM's loopback, not the host's. Containers reach the
host-side worker via `host.docker.internal`, so override these in `.env`
before `docker compose up`:

```bash
PIPECAT_WS_URL=ws://host.docker.internal:8082/freeswitch/audio
WORKER_EVENT_WEBHOOK=http://host.docker.internal:8082/freeswitch/events
VOICEBLENDER_WORKER_WS_BASE=ws://host.docker.internal:8082
SIPBRIDGE_WORKER_WS_BASE=ws://host.docker.internal:8082
```

The reverse direction (worker → ingress) is unaffected: Docker Desktop
exposes container-listening ports on the host's `localhost`.

### llm-agent side

The Node llm-agent process needs to know where to reach the worker:

```bash
export PIPECAT_WORKER_URL=http://127.0.0.1:8082
export PIPECAT_PUBLIC_URL=http://127.0.0.1:8082     # origin browsers hit
export PIPECAT_DISPATCH_TOKEN=<matches worker env>
export PIPECAT_JOIN_SECRET=<matches worker env>
```

`PIPECAT_PUBLIC_URL` should be the public origin (ngrok URL, LAN IP, etc.)
when the browser isn't on the same machine as the worker.

## Layout

```
pipecat_aplisay/         Python worker (FastAPI + Pipecat pipelines)
  worker.py              dispatch / WS endpoints, lifespan, gateway selection
  sip_gateway/           SipGateway interface and four implementations
  serializers/           wire-format adapters (FreeSWITCH L16+JSON, etc.)
  recording/             AES-GCM OGG/Opus → GCS pipeline
freeswitch/              FreeSWITCH image + dialplan / sofia profile
esl-poller/              TS sidecar — ESL → HTTP call-control API + webhook
sipbridge/               Go SIP UAS (sipgo + pion/rtp), distroless container
deploy/gcp/              Cloud Build + Cloud Run deployment
docker-compose.yml       production layout, four profiles
docker-compose.dev.yml   dev layout (ingress in containers, worker on host)
```

## Deeper documentation

Contract and design:

- [`docs/livekit-agent-architecture.md`](../../docs/livekit-agent-architecture.md) — the contract this worker honours (handler shape, REST callbacks, SIP wire headers, tool surface, transfer semantics, disconnect taxonomy). Re-read sections 6 and 8 when touching a gateway.
- [`lib/recording/CONTRACT.md`](../../lib/recording/CONTRACT.md) — recording wire format, shared with the LiveKit agent.

Per-ingress operator guides:

- [`docs/sipbridge-integration.md`](../../docs/sipbridge-integration.md) — sipbridge architecture, phases, wire contract.
- [`docs/voiceblender-integration.md`](../../docs/voiceblender-integration.md) — voiceblender operator guide.
- [`esl-poller/README.md`](esl-poller/README.md) — the FreeSWITCH call-control sidecar.
- [`deploy/gcp/README.md`](deploy/gcp/README.md) — GCP deployment.

Cross-cutting:

- [`docs/call-recording.md`](../../docs/call-recording.md)
- [`docs/call-transfers.md`](../../docs/call-transfers.md)
- [`docs/originate-api.md`](../../docs/originate-api.md)
- [`docs/call-hooks.md`](../../docs/call-hooks.md)

## Pipeline model registry

The single source of truth for which model IDs run in pipeline mode is
[`pipecat_aplisay/pipeline_model_ids.py`](pipecat_aplisay/pipeline_model_ids.py).
The JS server reads the same set from
[`lib/models/pipecat.js`](../../lib/models/pipecat.js); keep them in sync
until they're unified via a generated manifest.
