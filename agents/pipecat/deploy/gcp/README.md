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
- **Outbound trunk** (only needed if you place outbound calls or do
  WebRTC→telephony transfers): `PIPECAT_SIP_OUTBOUND` (e.g.
  `sip:sbc.aplisay.example:5061;transport=tls`), `PIPECAT_SIP_FROM_DOMAIN`,
  `PIPECAT_SIP_USERNAME`, `PIPECAT_SIP_PASSWORD`. Read by **sipbridge** (Go)
  and **FreeSWITCH** (`freeswitch/entrypoint.sh` derives `PIPECAT_SBC_PROXY`
  from the SIP URI). Voiceblender routes outbound inside its own backend, so
  it doesn't use these.

## secretenv — single-bundle secret delivery (optional)

The worker (Python), sipbridge (Go) and esl-poller (Node) all decrypt
`SECRETENV_BUNDLE` natively at startup, so you can deliver every secret as one
encrypted pair instead of listing them individually in `.env`. Build a bundle
locally with `npx secretenv -e`, then either:

- set `SECRETENV_KEY` + `SECRETENV_BUNDLE` directly in `.env.$ENVIRONMENT`
  (encrypted-at-rest there; plaintext only ever in container memory), **or**
- store them in Secret Manager under
  `${PROJECT_NUMERIC_ID}/secrets/<NAME>_KEY` and `<NAME>_BUNDLE`, set
  `GOOGLE_SECRETENV_PATH=projects/${PROJECT_NUMERIC_ID}/secrets/<NAME>` in
  `.env.$ENVIRONMENT`, and the worker + esl-poller fetch them at startup via
  the VM's `cloud-platform` OAuth scope. sipbridge (Go) does not currently
  fetch from Secret Manager itself — for the sipbridge profile, set
  `SECRETENV_KEY` / `SECRETENV_BUNDLE` directly.

### Publishing a bundle (`../bundle-secretenv.sh`)

`bundle-secretenv.sh` automates both halves — encrypting a `.env.$ENVIRONMENT`
into a `KEY+BUNDLE` pair, then writing the pair to Secret Manager under names
the env templates already point at:

```bash
cd agents/pipecat/deploy/gcp
../bundle-secretenv.sh           # interactive: prompts for env (dev/staging/production)
../bundle-secretenv.sh --env=staging --yes
../bundle-secretenv.sh --env=production --dry-run    # plan only
```

The script auto-detects the GCP backend from its cwd, reads `PROJECT_ID` from
`.env.$ENVIRONMENT`, encrypts via the canonical `secretenv` CLI (pulled by
`npx`, pinned to v1.0.5, so the bundle is byte-compatible with every
container's decryption path), and creates / adds a new version to:

```
projects/$PROJECT_ID/secrets/SECRETENV_PIPECAT_{DEV,STAGING,PRODUCTION}_KEY
projects/$PROJECT_ID/secrets/SECRETENV_PIPECAT_{DEV,STAGING,PRODUCTION}_BUNDLE
```

These names match the `GOOGLE_SECRETENV_PATH=projects/.../secrets/SECRETENV_PIPECAT_$ENV`
already in the env templates (the loaders append `_KEY` / `_BUNDLE`). The
generated `SECRETENV_KEY` never touches disk — only the encrypted bundle is
written to Secret Manager. After publishing, the script prints the
`gcloud secrets add-iam-policy-binding` command to grant the VM's service
account access to the new secrets if you haven't already at project level.

## Reusing the same images for local dev

The `agents/pipecat/docker-compose.yml` at the repo level builds the same
services from source. `deploy/gcp/docker-compose.gcp.yml` is shape-identical
but with `image:` lines pointing at Artifact Registry instead of `build:`
contexts — same env vars, same wiring.
