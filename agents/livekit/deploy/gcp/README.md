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
- [`deploy-cos.sh`](deploy-cos.sh) — the same deploy against a
  Container-Optimized OS VM. See [Comparing COS against
  Debian/Ubuntu](#comparing-cos-against-debianubuntu).
- [`bundle-secretenv.sh`](bundle-secretenv.sh) — encrypts a repo-root
  `.env.<env>` into a `SECRETENV_KEY` + `SECRETENV_BUNDLE` pair and publishes
  it to Secret Manager.
- [`status.sh`](status.sh) / [`log.sh`](log.sh) / [`upgrade.sh`](upgrade.sh) —
  operational one-liners over the node list from the last deployment.
- [`drain.sh`](drain.sh) — retire a runner without leaving a stale worker
  registration behind. See [Retiring a runner](#retiring-a-runner).

Generated locally and git-ignored: `.env.staging`, `.env.production`,
`docker-compose.yaml`, `.last-deployment`, `.last-deployment-cos`.

## Comparing COS against Debian/Ubuntu

The konlet runners this stack replaces ran on Container-Optimized OS, and
appear to use noticeably less CPU than the compose runners on Debian/Ubuntu.
[`deploy-cos.sh`](deploy-cos.sh) exists to isolate the host OS as the variable:
it ships the *same* generated `.env` and `docker-compose.yaml` to a COS node,
so the container's image, env, network mode, log driver and stop grace are
identical and only the OS underneath differs.

```bash
./deploy-cos.sh --components=create --nodes=livekit-cos-staging --zone=europe-west2-b --mirror=agent-runner-staging:europe-west2-b
```

Then deploy onto it, and print the facts worth diffing against the Debian node:

```bash
./deploy-cos.sh --env=staging --nodes=livekit-cos-staging --zone=europe-west2-b
```

```bash
./deploy-cos.sh --components=parity --yes
```

COS forces four departures from `deploy-node.sh`, all of them mechanical:

| | Debian/Ubuntu | COS |
|---|---|---|
| Docker | installed via `apt` | preinstalled; script only verifies |
| Registry auth | `gcloud auth print-access-token` on the VM | same token, read straight from the metadata server (COS has no `gcloud`) |
| Secret check | `gcloud secrets versions access` | Secret Manager REST call, HTTP status only — the payload is never fetched |
| `docker compose` | `docker-compose-plugin` package | v2 binary in `/var/lib/aplisay-compose/bin`, made runnable with the COS bind-mount + `remount,exec` workaround, symlinked into `~/.docker/cli-plugins` |

Two things to know before reading the numbers:

- Compare like with like. The GCE console's CPU metric is host-wide and
  normalised across vCPUs; `docker stats` is a percentage of *one* core and
  charges only the container's cgroup, so network softirq work never appears in
  it. `--components=parity` prints both sides plus the container's effective
  `LOGLEVEL` and `NUM_IDLE_PROCESSES`, which are the two settings most likely
  to differ between a konlet declaration and this compose file.
- `--components=create` provisions with `google-logging-enabled=false` and
  `google-monitoring-enabled=false`. The in-guest logging agent is itself a
  measurable CPU consumer, and the hypervisor-level CPU metric the comparison
  relies on is collected outside the guest regardless.

`upgrade.sh` does not work against a COS node — it shells out to `gcloud` on
the VM. Re-run `deploy-cos.sh`, which is idempotent. `status.sh` and `log.sh`
do work, but read `.last-deployment` (the Debian fleet), so name the node:
`NODES=livekit-cos-staging:europe-west2-b ./log.sh`.

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

### Retiring a runner

Once the new node is serving, the old one has to be drained — not just
stopped. Stopping a VM does not drain anything: dockerd kills containers after
its own `--shutdown-timeout` (15s), not the container's 300s
`stop_grace_period`, and a hard power-off never closes the registration
WebSocket at all. LiveKit Cloud can then keep offering jobs to a worker that no
longer exists until its own keepalive expires. Those jobs are never accepted,
so an inbound SIP leg waiting on that agent just rings until the A-leg's 30s
cap cancels it.

```bash
NODES=agent-runner-staging:europe-west2-b STOP_VM=1 ./drain.sh
```

`drain.sh` reports `active_jobs` from the worker's own health server, sends
SIGTERM (which makes `@livekit/agents` flip to `WS_FULL`, finish in-flight
calls, and close the socket), waits for the process to exit, and only then
stops the VM. `STOP_VM=1` implies `DOWN=1`, because `restart: always` would
otherwise re-register the worker the next time anyone starts that VM.

An exit code of 137 means the drain was SIGKILLed before it finished — the
stale-registration case — so the VM is left running for you to look at unless
you pass `FORCE=1`.

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

## Profiling a runner

Both of these are off by default and are switched on by editing `.env` and
re-running the deploy script — no image rebuild, no code change.

### Always-on: is the JS main thread the busy one?

`RUNTIME_STATS_MS=30000` (set in the env templates) makes every process — the
supervisor and each job process — log one line per interval:

```
runtime stats  role=job pid=41 ppid=1 loopP99Ms=0.9 loopMaxMs=1.2 cpuPct=12.4 rssMb=180
```

`loopP99Ms` is *excess* event-loop delay, so a healthy loop reads ~0-2 ms. The
combination is what matters:

| `cpuPct` | `loopP99Ms` | meaning |
| --- | --- | --- |
| high | high | the JS main thread is saturated — agent code, or something it calls synchronously |
| high | ~0 | the busy thread is **not** the JS main thread: a libuv threadpool thread (sync fs/crypto/zlib/dns), a V8 GC/JIT helper, or one of rtc-node's Rust/tokio threads |
| low | high | the loop is blocked waiting, not computing |

Line those up with `docker exec livekit-agent ps -ef --forest` using `pid`/`ppid`
to see whether it is the supervisor or a job process.

### On demand: V8 CPU profile

Uncomment both lines in `.env` and redeploy:

```
PROFILE_MS=90000
NODE_OPTIONS=--import /usr/src/app/dist/lib/profile-hook.js
```

`--cpu-prof` is rejected inside `NODE_OPTIONS`, and a profiler started from
`realtime.ts` is already too late: ESM imports are hoisted, so `lib/worker.js`
and its dependency graph are evaluated and JIT-compiled before the first
statement of `realtime.ts` runs. `--import` runs
[`lib/profile-hook.ts`](../../lib/profile-hook.ts) *before* the main module, so
the window covers module load and JIT warm-up as well as the first calls. That
matters here because the pool forks a replacement job process every time one is
consumed, so module load is paid per call, not just at boot.

`PROFILE_MS` is a window from process start. Each process writes
`cpu-<role>-<pid>-<epoch>.cpuprofile` into `~/livekit-agent/profiles` on the
VM; collect them with:

```bash
gcloud compute scp --recurse agent-runner-staging:~/livekit-agent/profiles ./profiles --zone=europe-west2-b
```

Open a `.cpuprofile` in Chrome DevTools (Performance → Load profile) or
[speedscope](https://www.speedscope.app/).

Two caveats. A process that exits before its window closes writes nothing — the
timer is deliberately `unref`'d so a spare job process is never held open. And
`PROFILE_SIGNAL=1` arms a SIGUSR2 toggle for ad-hoc capture
(`docker exec livekit-agent kill -USR2 <pid>`), which is off by default because
nodemon uses SIGUSR2 to restart and would make `yarn develop` unusable.

### Attaching a live inspector

`--inspect` *is* allowed in `NODE_OPTIONS`, and forked children get
auto-incremented ports. **Bind it to loopback and reach it over an SSH tunnel —
an exposed inspector port is remote code execution.**

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
