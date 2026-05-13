# GCP deployment — Aplisay Pipecat agent

Cloud Build + GCP Compute Engine deployment tooling for the three-container
Pipecat agent stack (`freeswitch`, `esl-poller`, `pipecat-worker`). Adapted
from `aplisay-b2bua/deploy/gcp/`.

## Files

- [`cloudbuild-staging.yaml`](cloudbuild-staging.yaml) — Cloud Build pipeline
  for the **staging** images. Build context for `pipecat-worker` is the repo
  root (the Dockerfile pulls in `agents/pipecat/`); the other two services
  build from their own directories. Tags pushed: `:staging` and `:$COMMIT_SHA`.
- [`cloudbuild.yaml`](cloudbuild.yaml) — same build, tagged `:latest` and
  `:$COMMIT_SHA`. Use for production releases.
- [`docker-compose.gcp.yml`](docker-compose.gcp.yml) — production / staging
  compose that **pulls** from Artifact Registry rather than building locally.
- [`env-example-staging`](env-example-staging) /
  [`env-example-production`](env-example-production) — env templates with
  `<NEW256bithexstring>` placeholders that `deploy-node.sh` fills in.
- [`deploy-node.sh`](deploy-node.sh) — one-shot deploy: process env template,
  copy files to a GCP VM, install Docker, authenticate Artifact Registry,
  pull the images, bring up the stack. Optional APIBAN iptables client
  install for SIP abuse defence.

## Image registry layout

```
${LOCATION}-docker.pkg.dev/${PROJECT_ID}/containers/${REPO_NAME}/freeswitch:{$SHA, staging, latest}
${LOCATION}-docker.pkg.dev/${PROJECT_ID}/containers/${REPO_NAME}/esl-poller:{$SHA, staging, latest}
${LOCATION}-docker.pkg.dev/${PROJECT_ID}/containers/${REPO_NAME}/pipecat-worker:{$SHA, staging, latest}
```

Defaults from the env templates: `LOCATION=europe-west1`,
`PROJECT_ID=llm-voice`, `REPO_NAME=aplisay-pipecat-agent`.

## Building images (Cloud Build)

```bash
# Staging
gcloud builds submit \
    --config agents/pipecat/deploy/gcp/cloudbuild-staging.yaml \
    --substitutions LOCATION=europe-west1 \
    .

# Production
gcloud builds submit \
    --config agents/pipecat/deploy/gcp/cloudbuild.yaml \
    --substitutions LOCATION=europe-west1 \
    .
```

The build runs from the repo root so the `pipecat-worker` Dockerfile can pull
in `agents/pipecat/` files. Both other services have self-contained build
contexts under `agents/pipecat/freeswitch/` and `agents/pipecat/esl-poller/`.

## Deploying to a VM

Prerequisites: `gcloud` CLI authenticated, `openssl` for secret generation, a
GCE VM with the `cloud-platform` OAuth scope (so it can authenticate to
Artifact Registry and Secret Manager from the metadata server).

```bash
cd agents/pipecat/deploy/gcp
./deploy-node.sh                       # all components (Docker + APIBAN)
./deploy-node.sh --components=docker   # Docker stack only
./deploy-node.sh --components=apiban   # APIBAN host firewall only
```

What `deploy-node.sh` does (`docker` component):

1. Prompts for environment (`staging` / `production`), VM name, and zone (last
   answers cached in `.last-deployment`).
2. Generates random 256-bit hex strings for `ESL_SECRET`, `CALL_API_TOKEN`,
   `WORKER_EVENT_TOKEN`, `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET` and
   substitutes them into `.env.$ENVIRONMENT`. Re-runs preserve any manually
   set `APIBAN_KEY` and `SHARED_API_TOKEN`.
3. Installs Docker on the VM if absent.
4. Configures Docker auth against Artifact Registry using the VM's service
   account.
5. Copies `.env` and `docker-compose.yaml` to `~/pipecat-agent/` on the VM.
6. Fetches the VM's external IP from the metadata server and writes it into
   `EXT_IP_ADDRESS` on the VM's `.env`.
7. Runs `docker compose pull && docker compose up -d` on the VM.

What `deploy-node.sh` does (`apiban` component): downloads the APIBAN
iptables client to the VM, drops a config with the key from `.env`, installs
a cron entry that runs the client every 4 minutes, and logrotates its log.

## Shared secrets you must populate manually

`deploy-node.sh` generates the per-stack secrets but **not** the values that
have to match what's deployed elsewhere in your infrastructure. Edit the
generated `.env.staging` / `.env.production` for:

- `SHARED_API_TOKEN` — value of the `x-shared-token` header for the llm-agent
  agent-db API. Must match `SHARED_API_TOKEN` on the llm-agent server side.
- `SERVICE_BASE_URI` — base URL of the llm-agent REST surface for this
  environment.
- Provider API keys (`OPENAI_API_KEY`, etc.) if you're not using
  `GOOGLE_SECRETENV_PATH` to inject them from Secret Manager.
- `PIPECAT_DISPATCH_TOKEN` and `PIPECAT_JOIN_SECRET` must also be set to the
  same values on the **llm-agent server** side
  (`lib/handlers/pipecat.js` reads them from process env). The script
  generates new random values on each run; if you want to keep them stable
  across deploys, either commit them to Secret Manager and read both ends
  from there, or delete the placeholders from the env template and set them
  in `.env.$ENVIRONMENT` manually before running the script.

## Reusing the same images for local dev

The `agents/pipecat/docker-compose.yml` at the repo level builds the same
services from source. `deploy/gcp/docker-compose.gcp.yml` is shape-identical
but with `image:` lines pointing at Artifact Registry instead of `build:`
contexts — same env vars, same wiring.
