# GCP deployment — Aplisay LiveKit agent

Docker Compose deployment tooling for the `livekit-agent` container on GCE VMs,
replicating the structure used by
[`aplisay-sbc/deploy/gcp/`](https://github.com/aplisay/aplisay-sbc) and
[`agents/pipecat/deploy/gcp/`](../../../pipecat/deploy/gcp).

> **WIP.** The scripts here have not yet been run against a live runner. The
> production runners still use the konlet (`gce-container-declaration`) path
> described under [Migrating an existing runner](#migrating-an-existing-runner).

## Why

The agent runners are currently deployed as GCE *container VMs* — a
`gce-container-declaration` metadata entry that konlet turns into a single
`klt-agent-runner-*` container. That has three problems this replaces:

1. **Secrets in metadata.** `SECRETENV_BUNDLE` + `SECRETENV_KEY` sit in
   instance metadata in plaintext, readable by anyone with
   `compute.instances.get`. Here they are read from Secret Manager by the
   container itself, at start-up, into the agent process's environment — they
   are never written to the VM's disk or to the operator's.
2. **No declarative record.** The runtime config lives only in the metadata of
   each VM. Here it is `env-example-{staging,production}` in the repo.
3. **Unbounded logs.** The runners accumulate ~1.4 GB of JSON logs, which makes
   `docker logs` unusable for call forensics. The compose file caps them at
   5 × 100 MB.

## Files

- [`docker-compose.gcp.yml`](docker-compose.gcp.yml) — the compose template
  that pulls `livekit-agent` from Artifact Registry. Copied to the VM as
  `~/livekit-agent/docker-compose.yaml`.
- [`env-example-staging`](env-example-staging) /
  [`env-example-production`](env-example-production) — non-secret env
  templates (image coordinates, log level, idle-process count, the Secret
  Manager path). `deploy-node.sh` turns these into `.env.<env>` and ships them
  as `~/livekit-agent/.env`.
- [`deploy-node.sh`](deploy-node.sh) — one-shot deploy to one or many VMs:
  installs Docker on a bare host, authenticates Artifact Registry, copies the
  env + compose files, checks the VM can read the secretenv pair, pulls and
  starts.
- [`bundle-secretenv.sh`](bundle-secretenv.sh) — encrypts a repo-root
  `.env.<env>` into a `SECRETENV_KEY` + `SECRETENV_BUNDLE` pair and publishes
  it to Secret Manager.
- [`status.sh`](status.sh) / [`log.sh`](log.sh) / [`upgrade.sh`](upgrade.sh) —
  operational one-liners over the node list from the last deployment.

Generated locally and git-ignored: `.env.staging`, `.env.production`,
`docker-compose.yaml`, `.last-deployment`.

## Image layout

```
europe-west1-docker.pkg.dev/llm-voice/containers/llm-agent/livekit-agent:{$SHA, staging, beta, latest}
#   staging = deploy/gcp/cloudrun/cloudbuild-livekit-staging.yaml
#   beta    = deploy/gcp/cloudrun/cloudbuild-livekit-beta.yaml
#   latest  = applied at release time by the top-level cloudbuild-release.yaml,
#             which promotes a verified :$COMMIT_SHA as a group
```

Nothing here builds images — the Cloud Build configs under
[`deploy/gcp/cloudrun/`](../../../../deploy/gcp/cloudrun) do that. This is the
deploy half only, which is why `cloudbuild-release.yaml` deploys Cloud Run
directly but leaves `livekit-agent` to a `:latest` promotion plus a manual
`./upgrade.sh`.

## Secrets

The agent's `dotenv` dependency is aliased to `github:rjp44/secretenv`, so
`dotenv.config()` decrypts `SECRETENV_BUNDLE` with `SECRETENV_KEY` into
`process.env` at startup. Everything real — `LIVEKIT_*`, `POSTGRES_*`,
provider API keys, `SHARED_API_TOKEN`, `SERVICE_BASE_URI` — comes from there,
not from `.env`.

**The LiveKit agent shares the llm-agent server's bundle**, so the secret names
are not agent-specific:

| Environment | Secret Manager names | `IMAGE_TAG` |
| --- | --- | --- |
| staging | `SECRETENV_STAGING_KEY` / `SECRETENV_STAGING_BUNDLE` | `staging` |
| beta | `SECRETENV_BETA_KEY` / `SECRETENV_BETA_BUNDLE` | `beta` |
| production | `SECRETENV_KEY` / `SECRETENV_BUNDLE` (unsuffixed) | `latest` |

`GOOGLE_SECRETENV_PATH` in each env template names the base
(`projects/<numeric>/secrets/SECRETENV_STAGING`); the loader appends `_KEY` /
`_BUNDLE`, exactly like the SBC and pipecat loaders.

### Where the pair actually comes from

Exactly the SBC pattern (`entrypoint.sh` → `eval $(node env-processor.js)`, via
`@google-cloud/secret-manager`) and the b2bua services': **the container
fetches its own secrets when it starts**. It is part of the image, not of this
deploy directory — [`agents/livekit/entrypoint.sh`](../../entrypoint.sh) and
[`agents/livekit/load-secretenv.js`](../../load-secretenv.js).

```
docker run  →  ENTRYPOINT /bin/sh /usr/src/app/entrypoint.sh   CMD start
                    │
                    ├─ node load-secretenv.js          (@google-cloud/secret-manager, ADC)
                    │    accessSecretVersion ${GOOGLE_SECRETENV_PATH}_KEY/versions/latest
                    │    accessSecretVersion ${GOOGLE_SECRETENV_PATH}_BUNDLE/versions/latest
                    │    decrypt → write credentials/google.json (0600, if absent)
                    │    → `export SECRETENV_KEY=… SECRETENV_BUNDLE=…` on stdout
                    ├─ eval it
                    └─ exec node dist/realtime.js start    ← becomes PID 1
```

Consequences worth knowing:

- **Nothing lands on a filesystem.** No `.env.secretenv` on the VM, no temp
  file on the operator's machine, nothing in instance metadata, no bind mount.
  The values exist only in the running agent's environment; `docker inspect`
  does not show them, and a stopped container has nothing to leak.
- **A rotation needs only a restart** — `./upgrade.sh` or
  `./deploy-node.sh --components=secrets` — not a re-deploy of any file.
- **The VM's service account must be able to read both secrets**
  (`roles/secretmanager.secretAccessor` + the `cloud-platform` scope). There is
  no operator-credentials fallback: `--local-secrets` is gone, because it
  worked by writing the key to disk. `--components=secrets` checks the access
  up front so a missing grant fails the deploy instead of crash-looping the
  container.
- **`exec` keeps the drain intact.** The agent, not the wrapper, is PID 1, so
  docker's `SIGTERM` reaches `@livekit/agents` and in-flight calls drain within
  `stop_grace_period`.
- **This needs a rebuilt image.** The compose file no longer overrides
  `entrypoint`/`command`, so a tag built before this change still carries the
  old `node dist/realtime.mjs` ENTRYPOINT and dies at once. Rebuild `:staging`
  / `:latest` before deploying.
- Setting `SECRETENV_KEY` + `SECRETENV_BUNDLE` directly still works and skips
  the fetch, which is what local runs and CI do.

### The Google service-account credential

`credentials/google.json` — the file `GOOGLE_APPLICATION_CREDENTIALS` names, and
what the `google-cloud-storage` client used for recording uploads actually
opens — is written by the same loader, from the `GOOGLE_CREDENTIAL` value in the
decrypted bundle. Mode `0600`, and skipped if something is already at that path
(a mounted secret wins).

It used to be baked at **build** time:

```dockerfile
RUN npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json   # removed
```

which left a live service-account private key in the layer of a *pushed* image
— readable by anyone who could pull it, and outliving every key rotation.

The objection is retention, not materialisation. Decrypting secrets during a
build is fine and sometimes necessary: `Dockerfile.test` does exactly that so
the CI suite can reach the external LLM providers (Google included), and that
image is a throwaway the `Test` step in `cloudbuild-staging.yaml` builds, runs
and discards without ever pushing it. What must not happen is a published
artefact carrying the key. Worth knowing if you fix one of the others: removing
the file in a later `RUN` does **not** achieve that — the layer that created it
still holds it, so it takes a same-layer `rm` or a multi-stage copy.

`agents/livekit`'s build runs no tests, so it needs no secrets at all: the image
takes no `SECRETENV_*` build args and the three
`deploy/gcp/cloudrun/cloudbuild-livekit*.yaml` configs pass none, which is why
one artefact is now valid in every environment. This mirrors
`agents/pipecat/pipecat_aplisay/secretenv.py::_materialise_google_credential`,
which has always done it this way.

### Publishing / rotating a bundle

```bash
cd agents/livekit/deploy/gcp
./bundle-secretenv.sh --env=staging          # add --yes / --dry-run
./deploy-node.sh --env=staging --components=secrets   # restart → re-fetch
```

`--env=production` writes the **shared production pair** — Cloud Run
`llm-agent`, `jambonz-agent` and the image builds read the same secrets, and
each picks up the new version at its next restart. The script warns and asks
for confirmation. Use `--secret-base=NAME` if you ever want an agent-specific
pair instead.

The generated `SECRETENV_KEY` never touches disk; only the encrypted bundle is
written to Secret Manager.

## Deploying

Prerequisites: `gcloud` authenticated, and a VM whose service account has the
`cloud-platform` OAuth scope plus `roles/secretmanager.secretAccessor` on the
two secrets. A bare Debian VM needs nothing else — the script installs Docker,
the compose plugin and (if missing) the gcloud CLI.

```bash
cd agents/livekit/deploy/gcp

# Interactive
./deploy-node.sh

# Staging
./deploy-node.sh --env=staging --nodes=agent-runner-staging --zone=europe-west2-b

# Production — several runners, per-node zones
./deploy-node.sh --env=production --nodes=\
agent-runner-production:europe-west1-d,\
agent-runner-production-be3:europe-west1-d,\
agent-runner-production-be4:europe-west1-b
```

Answers are cached in `.last-deployment`, so subsequent runs (and
`status.sh` / `log.sh` / `upgrade.sh`) need no arguments.

Components (`--components=`, default `docker,secrets`):

| Component | Does |
| --- | --- |
| `docker` | env + compose + entrypoint files, Docker install, Artifact Registry auth, file copy |
| `secrets` | verify the VM can read the pair, then recreate the container so it re-fetches |
| `konlet` | one-shot migration off the container-VM declaration (never implicit) |

Nodes are processed one at a time and each `up -d --force-recreate` lets the
old container drain first (`stop_grace_period: 300s`, and `@livekit/agents`
drains on `SIGTERM` because `ServerOptions` sets `production: true`). A
multi-node production run is therefore slow by design.

### Migrating an existing runner

An existing `agent-runner-*` VM runs the konlet container. If compose starts a
second one they both register with LiveKit and calls get dispatched to a
runner you are not managing. Migrate in one pass:

```bash
./deploy-node.sh --env=production --nodes=agent-runner-production:europe-west1-d \
    --components=konlet,docker,secrets
```

The `konlet` component stops and disables `konlet-startup`, removes the
`klt-*` container, and deletes the `gce-container-declaration` metadata key so
it does not come back on reboot. Do one node at a time and confirm calls are
landing before moving to the next.

## Day to day

```bash
./status.sh     # docker compose ps on every node
./log.sh        # follow (single node) or tail (many)
./upgrade.sh    # re-auth, pull the current tag, recreate with drain
```

For deep call forensics the on-host JSON log is still the fastest path, but it
now rotates at 100 MB — see the notes in
[`docs/`](../../../../docs) about grepping `docker inspect --format
'{{.LogPath}}'` rather than using `docker logs --since`.

## Known rough edges

- `agents/livekit/package.json`'s `start` / `stage` scripts still run
  `dist/realtime.mjs`, a path `tsup` has never emitted. The image no longer
  does (its `ENTRYPOINT` is `entrypoint.sh`), but those two scripts are still
  broken for local use.
- The other **published** Node images still leave `credentials/google.json` in
  what they push — `Dockerfile` (the llm-agent service, on Cloud Run) and
  `agents/jambonz/Dockerfile`. They want the same runtime rehydration.
  `Dockerfile.test` writes it too, but that one is the CI test runner: never
  pushed, and its tests need live provider credentials, so it stays as it is.
- `deploy/gcp/cloudrun/cloudbuild-livekit-staging.yaml` sets
  `_SERVICE_NAME: livekit-agent-staging`, which would push to an image that
  does not exist in the registry — the `:staging` tag that is actually deployed
  lives on `livekit-agent`. Reconcile before relying on the staging trigger.
- No health check is wired up. The worker serves on container port 8081; the
  compose file has a commented-out host-local port mapping if you want it.
