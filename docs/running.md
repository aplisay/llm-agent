# Running llm-agent

How to get from a clone to an agent you can talk to: install, environment, database, workers, tests and deployment. For what the pieces *are*, read the [architecture overview](architecture.md) first.

## Prerequisites

- **Node.js 22 LTS or 24** and **yarn 1.x**. Node 23 is not supported: `yarn install` refuses it. `.nvmrc` names 22 for `nvm use`.
- **PostgreSQL** (CI runs against Postgres 15). For a throwaway local instance:

  ```shell
  docker run -d --name llm-postgres -p 5432:5432 \
    -e POSTGRES_DB=llmvoice -e POSTGRES_USER=llm -e POSTGRES_PASSWORD=secret postgres:15
  ```

- Credentials for **at least one LLM provider** (Anthropic, OpenAI, Google or Ultravox), and for **one runtime** you intend to use (see [minimum viable setups](#minimum-viable-setups)).
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
| Core | `WS_PORT` (or `PORT`), `LOGLEVEL` | HTTP + WebSocket listen port, default `4000`; `WS_PORT` wins when both are set. pino level |
| Database | `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | Optional mTLS via `POSTGRES_CA/CERT/KEY`. In `NODE_ENV=development` the schema syncs automatically; in production upgrades run through the internal schema-version gate — never set `DB_FORCE_SYNC` there. The schema work every process runs at start is serialised across processes by a Postgres advisory lock (`lib/boot-lock.js`), so replicas starting together take turns rather than racing |
| Secrets at rest | `CREDENTIALS_KEY` | Encrypts stored SIP passwords and key material. Unset ⇒ plaintext with a logged warning; set it (`openssl rand -base64 32`) in every real deployment |
| Auth | `BOOTSTRAP_API_KEY`, or run `yarn bootstrap` | Every request needs an API key: see [First API key](#first-api-key). Firebase (legacy) and better-auth (`BETTER_AUTH_*`) add user sign-in for multi-user deployments and are optional |
| LLM providers | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`, `ULTRAVOX_API_KEY` | Enable only what this deployment uses |
| Speech | `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `NEUPHONIC_API_KEY`, `CARTESIA_API_KEY`, Google credentials as above | Needed for pipeline (non speech-to-speech) models |
| LiveKit runtime | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit Cloud or self-hosted |
| Pipecat runtime | `PIPECAT_WORKER_URL`, `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`, `PIPECAT_PUBLIC_URL` | See worker section below |
| Jambonz runtime | `JAMBONZ_SERVER`, `JAMBONZ_API_KEY`, `JAMBONZ_AGENT_NAME` | Requires a Jambonz instance/account with spare inbound numbers |
| Recording | `RECORDING_STORAGE_PATH` | `gs://bucket/prefix` for call recordings |

## Minimum viable setups

You don't need everything. Three sensible starting points:

1. **WebRTC only (no telephony)** — Postgres + one LLM key + LiveKit credentials (+ Deepgram/ElevenLabs for pipeline voices). Agents are reachable in browser rooms; nothing SIP is involved.
2. **Telephony via Jambonz** — the quickest route to a real phone number: a [Jambonz](https://jambonz.org) account with unallocated inbound numbers routed from your SIP trunk provider, STT/TTS credentials added on the Jambonz side, and the `JAMBONZ_*` variables here.
3. **Telephony via the Pipecat worker** — self-contained SIP using one of the supported gateways (bundled Go [`sipbridge`](sipbridge-integration.md), FreeSWITCH, [Voiceblender](voiceblender-integration.md) or Daily). Most control, most moving parts.

## First API key

Every request needs an API key, and a new database has no users. Create the first key in one of two ways:

- Run `yarn bootstrap`. It creates one organisation, one user and one key, and prints the key. Options: `--key`, `--org`, `--name`, `--email`.
- Or set `BOOTSTRAP_API_KEY` in `.env` to a random value of 32 characters or more (`openssl rand -base64 32`). The server creates the same three rows, with that key, when it first starts.

Both do nothing once any user exists, so `BOOTSTRAP_API_KEY` can stay set. The user has the `superAdmin` role, so it can also set up trunks, numbers and rate cards. Neither way needs Firebase or better-auth.

Send the key as a bearer token:

```shell
export APLISAY_KEY="<your key>"
```

For more users or keys, use `node tools/agent-admin.js` (`add-org`, `add-user`, `add-authkey`, `list-authkeys`).

## Start the server

```shell
yarn develop   # NODE_ENV=development, nodemon, debug logging
yarn start     # production mode
```

The API and WebSocket listen on `WS_PORT`, else `PORT`, else 4000. Sanity-check with the model catalogue:

```shell
curl -H "Authorization: Bearer $APLISAY_KEY" http://localhost:4000/api/models
```

The REST surface is defined in [`api/api-doc.yaml`](../api/api-doc.yaml) and browsable as a hosted reference at [llm.aplisay.com/api](https://llm.aplisay.com/api). The open-source [llm-frontend](https://github.com/aplisay/llm-frontend) gives you a UI over your own instance.

## Workers

The API server alone can run **Ultravox** agents (their cloud is the runtime) and headless **text** agents. Everything else needs its runtime worker:

- **LiveKit** (`agents/livekit`, TypeScript): for development, `yarn livekit-dev` from the repo root. It builds the worker and runs it with the same `.env` as the API server. In production it runs as its own container, built with `docker build -f agents/livekit/Dockerfile .` from the repo root.
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

Every image builds with the repo root as the build context:

| Image | Build command |
|---|---|
| API server | `docker build -f Dockerfile .` |
| LiveKit worker | `docker build -f agents/livekit/Dockerfile .` |
| Pipecat worker | `docker build -f agents/pipecat/Dockerfile .` |
| sipbridge (Pipecat SIP gateway) | `docker build -f agents/pipecat/sipbridge/Dockerfile .` |
| Jambonz worker | `docker build -f agents/jambonz/Dockerfile .` |

**Configuration.** Every image reads plain environment variables, the same names as `.env`. Pass them with `docker run -e`, an env file, a Kubernetes Secret or your platform's settings. [secretenv](https://github.com/rjp44/secretenv) is optional: it lets a deploy ship the whole environment as one encrypted value (`SECRETENV_KEY` plus `SECRETENV_BUNDLE`), and an image with neither set reads its environment as given. `deploy/bundle-secretenv.sh` makes such a pair from an env file.

Where Aplisay's own deploy files live, for reference:

- **Cloud Build** (`deploy/gcp/cloudrun/`, `cloudbuild-release.yaml`): builds the images. The API server and the Jambonz worker run on Cloud Run.
- **LiveKit worker**: Docker Compose on Compute Engine VMs, `agents/livekit/deploy/gcp/`.
- **Pipecat worker and SIP gateways**: Kubernetes, `agents/pipecat/deploy/k8s/`, or Compute Engine VMs, `agents/pipecat/deploy/gcp/`.
- **API server on Kubernetes**: `deploy/k8s/beta/`.

These name Aplisay's projects, hosts and registries. Treat them as examples.

Production checklist: API keys kept secret and `SHARED_API_TOKEN` set to a random value, user sign-in configured if you need it (Firebase or `BETTER_AUTH_ENABLED=true`), `CREDENTIALS_KEY` set, `DB_FORCE_SYNC` unset, recording bucket configured if used, and your authentication and multi-tenancy configuration reviewed. Vulnerability reports go via [SECURITY.md](../SECURITY.md).
