# Running llm-agent

How to get from a clone to an agent you can talk to: install, environment, database, workers, tests and deployment. For what the pieces *are*, read the [architecture overview](architecture.md) first.

## Prerequisites

- **Node.js 22+** and **yarn 1.x** (the production image is built `FROM node:22`).
- **PostgreSQL** (CI runs against Postgres 15). For a throwaway local instance:

  ```shell
  docker run -d --name llm-postgres -p 5432:5432 \
    -e POSTGRES_DB=llmvoice -e POSTGRES_USER=llm -e POSTGRES_PASSWORD=secret postgres:15
  ```

- Credentials for **at least one LLM provider** (Anthropic, OpenAI, Google, Groq or Ultravox), and for **one runtime** you intend to use (see [minimum viable setups](#minimum-viable-setups)).
- **Python 3.11+ with [`uv`](https://docs.astral.sh/uv/)** — only if you will run the Pipecat worker.

## Install

```shell
git clone https://github.com/aplisay/llm-agent.git && cd llm-agent
yarn install
(cd agents/livekit && yarn install)   # the LiveKit worker is a TypeScript sub-project
```

The LiveKit worker is compiled automatically (`predevelop`/`prestart` run its `yarn build`), so the sub-project install above is the only extra step.

## Configure

Copy the annotated template and edit it — `environment-example` is the reference for every variable, with inline comments:

```shell
cp environment-example .env
```

The essentials, by group:

| Group | Variables | Notes |
|---|---|---|
| Core | `WS_PORT`, `LOGLEVEL` | HTTP + WebSocket listen port, default `4000`; pino level |
| Database | `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | Optional mTLS via `POSTGRES_CA/CERT/KEY`. In `NODE_ENV=development` the schema syncs automatically; in production upgrades run through the internal schema-version gate — never set `DB_FORCE_SYNC` there |
| Secrets at rest | `CREDENTIALS_KEY` | Encrypts stored SIP passwords and key material. Unset ⇒ plaintext with a logged warning; set it (`openssl rand -base64 32`) in every real deployment |
| Auth | `AUTHENTICATE_USERS=NO` for a local instance | Real deployments use Firebase (legacy) or better-auth (`BETTER_AUTH_*`), plus org-scoped API keys |
| LLM providers | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`, `GROQ_API_KEY`, `ULTRAVOX_API_KEY` | Enable only what this deployment uses |
| Speech | `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, Google credentials as above | Needed for pipeline (non speech-to-speech) models |
| LiveKit runtime | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud or self-hosted |
| Pipecat runtime | `PIPECAT_WORKER_URL`, `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`, `PIPECAT_PUBLIC_URL` | See worker section below |
| Jambonz runtime | `JAMBONZ_SERVER`, `JAMBONZ_API_KEY`, `JAMBONZ_AGENT_NAME` | Requires a Jambonz instance/account with spare inbound numbers |
| Recording | `RECORDING_STORAGE_PATH` | `gs://bucket/prefix` for call recordings |

## Minimum viable setups

You don't need everything. Three sensible starting points:

1. **WebRTC only (no telephony)** — Postgres + one LLM key + LiveKit credentials (+ Deepgram/ElevenLabs for pipeline voices). Agents are reachable in browser rooms; nothing SIP is involved.
2. **Telephony via Jambonz** — the quickest route to a real phone number: a [Jambonz](https://jambonz.org) account with unallocated inbound numbers routed from your SIP trunk provider, STT/TTS credentials added on the Jambonz side, and the `JAMBONZ_*` variables here.
3. **Telephony via the Pipecat worker** — self-contained SIP using one of the supported gateways (bundled Go [`sipbridge`](sipbridge-integration.md), FreeSWITCH, [Voiceblender](voiceblender-integration.md) or Daily). Most control, most moving parts.

## Start the server

```shell
yarn develop   # NODE_ENV=development, nodemon, debug logging
yarn start     # production mode
```

The API and WebSocket listen on `WS_PORT` (default 4000). Sanity-check with the model catalogue:

```shell
curl http://localhost:4000/api/models
```

The REST surface is defined in [`api/api-doc.yaml`](../api/api-doc.yaml) and browsable as a hosted reference at [llm.aplisay.com/api](https://llm.aplisay.com/api). The open-source [llm-frontend](https://github.com/aplisay/llm-frontend) gives you a UI over your own instance.

## Workers

The API server alone can run **Ultravox** agents (their cloud is the runtime) and headless **text** agents. Everything else needs its runtime worker:

- **LiveKit** (`agents/livekit`, TypeScript): for development, `yarn livekit-dev` from the repo root; in production it runs as its own container, built from that directory.
- **Pipecat** (`agents/pipecat`, Python): managed with `uv`, launched with an explicit SIP gateway selection and env file (it does not read `.env` implicitly), e.g.

  ```shell
  cd agents/pipecat
  SIP_GATEWAY=sipbridge uv run --env-file .env python -m pipecat_aplisay
  ```

  `SIP_GATEWAY` selects the telephony ingress (`sipbridge`, `freeswitch`, `voiceblender`, `daily`); Kubernetes manifests live in `agents/pipecat/deploy/k8s`.
- **Jambonz** (`agents/jambonz`, Node.js): interfaces the API server to an external Jambonz cluster for SIP calls with text-pipeline models.

## Tests

```shell
yarn test:no-db   # fast suite, no database or docker required
yarn test:db      # full suite against a docker-compose Postgres
yarn test:ci      # the CI runner, fully containerised
```

Some suites exercise live external services (e.g. ElevenLabs voices, jambonz.cloud) and need real credentials to pass. [ci-testing.md](ci-testing.md), [test-strategies.md](test-strategies.md) and [test-coverage.md](test-coverage.md) describe the approach.

## Deploying

- **Docker**: the top-level `Dockerfile` builds the API server image (Node 22); worker images build from their `agents/<runtime>` directories.
- **Google Cloud Run / Cloud Build**: pipelines in `deploy/gcp/cloudrun/` cover the server and each worker, including staging variants; `deploy/bundle-secretenv.sh` bundles encrypted environment for images.
- **Kubernetes**: Pipecat worker + SIP gateway manifests in `agents/pipecat/deploy/k8s`.

Production checklist: authentication on (Firebase or `BETTER_AUTH_ENABLED=true`), `CREDENTIALS_KEY` set, `DB_FORCE_SYNC` unset, recording bucket configured if used, and your authentication and multi-tenancy configuration reviewed. Vulnerability reports go via [SECURITY.md](../SECURITY.md).
