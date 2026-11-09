# Run the stack locally with Docker Compose

This brings up the API server, PostgreSQL, a LiveKit server, the LiveKit worker
and a test page on one machine. You need Docker with Compose 2.24 or later, and
free ports 4000, 7880, 7881, 7882/udp and 8080 on 127.0.0.1.

## Start

```shell
git clone https://github.com/aplisay/llm-agent.git && cd llm-agent
scripts/compose-setup.sh
docker compose up --build
```

`scripts/compose-setup.sh` copies `environment-example` to `.env` and fills in
random secrets: a first API key (`BOOTSTRAP_API_KEY`), `CREDENTIALS_KEY`,
`SHARED_API_TOKEN`, the database password and a LiveKit key pair. It prints the
API key and the URLs. It keeps any value already in `.env`, so it is safe to
run again.

A bare `docker compose up` without the script also works. The services then use
fixed development secrets from `compose.yaml`, and you create a key with
`docker compose exec api yarn bootstrap`.

The first build takes a few minutes. When the API is up:

```shell
curl http://localhost:4000/api/health
```

lists each runtime and provider as enabled or disabled, and names what a
disabled one is missing. `livekit` and `text` should be enabled.

## Talk to an agent

Add one model provider key to `.env` and restart with `docker compose up -d`.
The smallest set for a spoken conversation is `OPENAI_API_KEY`: the
`livekit:openai/gpt-realtime` model needs no separate speech-to-text or
text-to-speech key.

```shell
export APLISAY_KEY=<the key compose-setup.sh printed>
curl -s -H "Authorization: Bearer $APLISAY_KEY" -H 'Content-Type: application/json' \
  http://localhost:4000/api/agents -d '{
    "name": "Test agent",
    "modelName": "livekit:openai/gpt-realtime",
    "prompt": "You are a friendly assistant. Keep answers short.",
    "options": { "tts": { "voice": "alloy" } }
  }'
```

Then open the test page at <http://localhost:8080>, paste the API key, load the
agents, pick yours and press **Start talking**. The browser asks for the
microphone.

The test page is for development only. Never publish it on a public host.

## What runs where

| Service | Port | What it is |
|---|---|---|
| `postgres` | none | PostgreSQL 15, data in the `pgdata` volume |
| `api` | 4000 | The API server |
| `livekit` | 7880, 7881, 7882/udp | LiveKit server |
| `livekit-worker` | none | The LiveKit voice worker. It shares the `livekit` container's network |
| `ui` | 8080 | The test page, with a proxy to the API |

Recordings go to the `recordings` volume (`RECORDING_STORAGE_PATH=file:///data/recordings`),
which the worker writes and the API server reads. Set `RECORDING_STORAGE_PATH` in
`.env` to use an `s3://` or `gs://` bucket instead.

Ports are published on 127.0.0.1. Set `APLISAY_BIND=0.0.0.0` in `.env` to
publish them on every interface.

The browser reaches LiveKit at `LIVEKIT_PUBLIC_URL` (default
`ws://localhost:7880`), and LiveKit advertises its media address as
`LIVEKIT_NODE_IP` (default `127.0.0.1`). To use the stack from another machine,
set both to this host's address.

## Optional profiles

- `docker compose --profile sip-livekit up` adds LiveKit SIP and Redis for phone
  calls. It needs a public IP; see the comments in `compose.yaml`.
- `docker compose --profile edge up` adds Caddy for TLS on a public host. Set
  `APLISAY_DOMAIN`, `LIVEKIT_DOMAIN` and `LIVEKIT_PUBLIC_URL` first.

The Pipecat worker and its SIP gateway are not in `compose.yaml` yet.

## Smoke test

`scripts/smoke.sh` builds and starts the stack, checks `GET /api/health`, uses
the first API key, creates a text agent on `text:stub/echo` and runs one chat
round trip, then tears the stack down. It needs no provider key: the stub
model, which repeats its input, is listed only when `APLISAY_STUB_MODEL=1`,
and the script sets that for its own run. CI runs the same script on every
pull request to `next`.

## Stop and reset

```shell
docker compose down        # stop, keep the database
docker compose down -v     # stop and delete the database
```

If you delete `.env` but keep the database volume, the new database password
will not match. Delete the volume too, or keep the old `.env`.
