# Kubernetes deployment — Aplisay Pipecat agent

A portable Kubernetes deploy for the Pipecat agent that runs on **GCP (GKE),
DigitalOcean (DOKS), and AWS (EKS)**. It is the cluster-native counterpart to the
VM/docker-compose deploy in [`../gcp`](../gcp).

## Why this is shaped the way it is

The SIP/media gateway (sipbridge / FreeSWITCH / Voiceblender) owns a large,
**1:1-mapped RTP UDP port range** and must advertise an **external IP the SBC can
send media straight at**. RTP cannot be NAT-multiplexed or fanned out through an
L7 proxy. That forces three things:

1. **Host networking** — the gateway binds the node's real interfaces so the RTP
   ports map 1:1 to the host with no CNI translation.
2. **Exactly one media handler per node** — two gateways on one node would fight
   over the same UDP ports and external IP. A **DaemonSet** guarantees one pod
   per node.
3. **Per-node external IP** — each pod must advertise *its own node's* public IP
   in SDP. An initContainer detects it from the cloud metadata server.

Signalling is simpler. We assume **all inbound calls from our SBCs are TLS on
5061** (no UDP signalling, so no NAT/source-mangling worries), which means an
ordinary **L3/L4 load balancer** (TCP passthrough) can front 5061 and spread
connections across nodes. **Media bypasses the LB**: whichever node answers a
call advertises its own external IP, so RTP flows direct to that node.

```
            SBC (TLS/5061)                       SBC (RTP/UDP)
                  │                                    │
                  ▼                                    │ direct to the
        ┌───────────────────┐                          │ answering node's
        │  L3 LoadBalancer  │  (Service type: LB)      │ external IP
        │   TCP 5061 only   │                          │
        └─────────┬─────────┘                          │
        ┌─────────┼───────────────── nodes ────────────┼─────────┐
        ▼         ▼                                     ▼         ▼
   ┌─────────┐ ┌─────────┐                         ┌─────────┐ (one DaemonSet
   │ node A  │ │ node B  │   …                     │ node N  │  pod per node)
   │ gw+wkr  │ │ gw+wkr  │                         │ gw+wkr  │  hostNetwork
   └─────────┘ └─────────┘                         └─────────┘
```

Each pod co-locates the **SIP gateway container(s) + the pipecat-worker** sharing
the host network namespace, so they talk over `127.0.0.1` — a 1:1 translation of
the `network_mode: host` docker-compose topology.

## Layout

```
deploy/k8s/
  base/                         # gateway-agnostic; not applied directly
    namespace.yaml              # namespace + PSA=privileged (hostNetwork needs it)
    configmap.yaml              # pipecat-config (non-secret env)
    secret.example.yaml         # pipecat-secrets template (create out-of-band)
    secretenv.example.yaml      # alt: pipecat-secretenv (KEY+BUNDLE) template
    sip-tls-secret.example.yaml # optional CA-signed TLS keypair template
    scripts/detect-external-ip.sh
    daemonset.yaml              # hostNetwork pod: initContainers + worker + volumes
    service-sip.yaml            # LoadBalancer, TCP 5061 (signalling)
    service-worker.yaml         # ClusterIP, 8082 (dispatch / control)
    kustomization.yaml
  components/                   # layer onto an overlay
    cloud-gcp/  cloud-aws/  cloud-digitalocean/   # per-cloud LB annotations
    env-production/             # override image tags to :latest (base defaults :next)
    webrtc-do/                  # adds 443->:8082 (WebRTC TLS) to the SIP LB (see WebRTC)
  overlays/                     # pick one
    sipbridge/                  # DEFAULT — TLS-only, UDP disabled, self-signed fallback
    freeswitch/                 # FreeSWITCH + esl-poller sidecar
    voiceblender/               # third-party image (see caveats)
```

## Prerequisites

1. **A dedicated SIP node pool** whose nodes have **public/external IPs** (or 1:1
   NAT) reachable by your SBCs, labelled so the DaemonSet lands only there.
   Label the **POOL**, not the nodes, so that every node the pool ever creates
   carries it — an autoscaled node, or a node replaced by an upgrade or an
   auto-repair, comes up bare otherwise and silently runs no SIP pod:
   ```
   # DigitalOcean (--label REPLACES the pool's label set, so pass them all):
   doctl kubernetes cluster node-pool update <cluster-id> <pool> \
       --label aplisay.com/pipecat-sip=true
   # GKE:  gcloud container node-pools create … --node-labels=aplisay.com/pipecat-sip=true
   # EKS:  eksctl … --node-labels aplisay.com/pipecat-sip=true
   ```
   `kubectl label node <node> aplisay.com/pipecat-sip=true` is for
   single-node/test clusters only: it labels the node that exists right now, and
   nothing the cluster creates later.
2. **Firewall** opened on those nodes:
   - `TCP 5061` (SIP TLS) — from your SBC source ranges
   - `UDP 10000-20000` (RTP — sipbridge / voiceblender) **or** `UDP 16384-16484`
     (RTP — FreeSWITCH; see its `vars.xml`) — **open to all sources** (`0.0.0.0/0`):
     we take direct media from any source IP, so the RTP range is not source-scoped
3. **Images** — the deploy pulls the same Artifact Registry images that
   [`../gcp/cloudbuild*.yaml`](../gcp) build:
   `europe-west1-docker.pkg.dev/llm-voice/containers/llm-agent/{pipecat-worker,sipbridge,freeswitch,esl-poller}`.
   On GKE the nodes' service account can pull directly. On EKS/DOKS, add an
   imagePullSecret (below) or mirror the images to your own registry and override
   the tags via `kustomize edit set image`.
4. **Secrets** created in the namespace (next section).

## Quick start (sipbridge default)

This uses the **secretenv bundle** — one encrypted Secret for every credential
("Option B" below). It's our standard for staging and production, and
`bundle-secretenv.sh` does the namespace + Secret bootstrap for you.

```bash
# 1. Build this environment's source .env from the k8s template, then edit it to
#    fill in the secrets (tokens, provider keys, PIPECAT_SIP_PASSWORD, …). It
#    lives next to the template as agents/pipecat/.env.<env>, and is git-ignored.
cd agents/pipecat
cp env-example-k8s .env.staging           # or .env.production
${EDITOR:-vi} .env.staging                # fill in the SECRETS section

# 2. Encrypt it into the `pipecat-secretenv` Secret. This also creates the
#    `pipecat` namespace (with the PodSecurity 'privileged' labels hostNetwork
#    needs) if it isn't there yet.
cd deploy/k8s
../bundle-secretenv.sh --env=staging      # interactive confirm; add --yes to skip

# 3. Label the node(s) the SIP pod should run on. The DaemonSet ONLY schedules
#    on nodes with this label — without it you get a DaemonSet with 0 pods.
#    On a real cluster label the POOL (see Prerequisites) so autoscaled and
#    replacement nodes inherit it. On a single-node / test cluster:
kubectl label nodes --all aplisay.com/pipecat-sip=true

# 4. (Optional) a CA-signed SIP TLS cert; otherwise the gateway self-signs.
# kubectl create secret tls pipecat-sip-tls -n pipecat \
#     --cert=fullchain.pem --key=privkey.pem

# 5. Apply the gateway overlay (sipbridge is the default).
kubectl apply -k overlays/sipbridge

# 6. Verify (see "Verification" below).
```

> **Which cluster:** the bundler binds `--env=staging` to AMS3 and `--env=beta`
> to LON1, and pins `--context` on every kubectl call, so your current context is
> irrelevant and a bundle cannot land on the wrong cluster. `dev` and
> `production` have no binding — name the cluster with `--k8s-context=<context>`
> (production's overlay has run on more than one cluster, so it is not guessed).

`PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`, and `SHARED_API_TOKEN` in the
bundle **must match the llm-agent server side**. Also set `SERVICE_BASE_URI` (the
llm-agent REST base) in `base/configmap.yaml`.

> **Rotate / change a secret:** edit `agents/pipecat/.env.staging`, re-run
> `../bundle-secretenv.sh --env=staging`, then `kubectl rollout restart
> daemonset/pipecat-sip -n pipecat` to roll the pods onto the new values.
>
> **Dev, or prefer a plain one-key-per-value Secret?** Use Option A in *Secrets*
> below in place of steps 1–2.

## Secrets: two delivery options

Both Secrets are mounted via `envFrom: secretRef` — Kubernetes injects them as
environment variables straight from the apiserver into the container. **Nothing
is written to disk inside the pod**, and bundle decryption runs in-process before
the worker / gateway starts.

You need **one** of them. `pipecat-secrets` and `pipecat-secretenv` are both
`optional: true` in the DaemonSet, so a missing one doesn't block startup; if
both exist, the bundle's decrypted values override the plain Secret.

### Option B — `pipecat-secretenv` (bundle) — the standard

One encrypted `SECRETENV_KEY` + `SECRETENV_BUNDLE` pair carries every secret:
fewer moving pieces, easy rotation, and you can split the key and the bundle
across different storage backends for defence in depth (an attacker needs both).

`bundle-secretenv.sh` is the supported path (the Quick Start uses it). Run it
from `deploy/k8s/`; it:

1. reads the source `.env` at **`agents/pipecat/.env.<env>`** (two levels up —
   build it from `agents/pipecat/env-example-k8s`),
2. encrypts it with the canonical `secretenv` CLI (pinned to the version the
   containers decrypt with, so the bundle is always wire-compatible),
3. creates the `pipecat` namespace (with PSA labels) if needed, and
4. applies `pipecat-secretenv-<env>` plus the active `pipecat-secretenv` alias —
   the name the overlays `envFrom`, so no kustomize change is needed.

```bash
cd agents/pipecat/deploy/k8s
../bundle-secretenv.sh --env=staging        # or --env=production
```

`env-example-k8s` lists the secrets and deliberately OMITS per-node values
(`EXT_IP_ADDRESS`, `SIPBRIDGE_SIP_SIGNAL_IP`/`MEDIA_IP`) — the `detect-ip`
initContainer sets those per node, and bundling them would override detection and
break media. The `.env.<env>` you create is git-ignored. (The same script with a
GCP backend publishes to Secret Manager instead — see the GCP README.)

**Manual equivalent (no script):**

```bash
export SECRETENV_KEY=$(openssl rand -base64 36)
export $(npx -y -p github:rjp44/secretenv#v1.0.5 secretenv -e -p agents/pipecat/.env.staging)
kubectl create secret generic pipecat-secretenv -n pipecat \
    --from-literal=SECRETENV_KEY="$SECRETENV_KEY" \
    --from-literal=SECRETENV_BUNDLE="$SECRETENV_BUNDLE"
```

Each container decrypts on its own at startup:

- **worker** (Python) — `pipecat_aplisay/secretenv.py` runs in `__main__` before
  any config is read; HMAC-derives the key and AES-CBC-decrypts into `os.environ`.
- **sipbridge** (Go) — `internal/secretenv` runs in `main` before `config.Load()`.
- **esl-poller** (Node) — the upstream `dotenv`/`secretenv` hook already does it.
- **FreeSWITCH / Voiceblender** — launched via `secretenv-exec`, a static Go
  wrapper that decrypts the bundle in its own env and `syscall.Exec`s the real
  command so it inherits the decrypted env.

Plaintext secrets only ever exist in process memory and the kernel env page — no
tmpfs file, no `volumes:` mount of a Secret. (The bundle format + CLI is
`github.com/rjp44/secretenv`; the Python and Go decoders here are wire-compatible
and tested against a Node-produced fixture.)

### Option A — `pipecat-secrets` (one key per variable) — simple / dev

A plain Secret, one key per value; good for dev or quick edits. Template:
`base/secret.example.yaml` (generate per-stack tokens with `openssl rand -hex 32`).

```bash
cp base/secret.example.yaml /tmp/pipecat-secret.yaml   # edit it, then:
kubectl apply -n pipecat -f /tmp/pipecat-secret.yaml
```

## Image tags: staging (`next`) vs production (`latest`)

Following the repo convention, staging images are published under the **`next`**
tag and production releases under **`latest`** (the GCP `cloudbuild-staging.yaml`
pushes `:next`, `cloudbuild.yaml` pushes `:latest`).

The base — and therefore a bare `kubectl apply -k overlays/<gateway>` — defaults
to **`next`** (staging, the common iterative case). For a **production** deploy,
layer `components/env-production`, which overrides every image to `latest`:

```yaml
# prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../overlays/sipbridge
components:
  - ../components/env-production    # -> :latest
  - ../components/cloud-gcp         # optional per-cloud LB annotations
```
```bash
kubectl apply -k prod
```

For a one-off tag, `cd overlays/sipbridge && kustomize edit set image \
europe-west1-docker.pkg.dev/llm-voice/containers/llm-agent/sipbridge=*:<tag>`.

### Adding per-cloud LB annotations

The base `pipecat-sip` Service is a plain `type: LoadBalancer`. To apply
cloud-specific annotations (NLB on AWS, TCP mode on DO), make a thin local
overlay combining the gateway overlay with a cloud component (and, for
production, the `env-production` component above):

```yaml
# my-eks/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../overlays/sipbridge
components:
  - ../components/cloud-aws
```
```bash
kubectl apply -k my-eks
```

**DigitalOcean — stable LB IP.** DO does **not** let you assign a reserved IP to a
*managed* load balancer: reserved IPs attach to Droplets only, and the CCM ignores
`spec.loadBalancerIP` (it just provisions a fresh DO IP). Instead, pin the LB's
**name** so the CCM always reconciles the same LB and its DO-assigned IP persists.
The committed `do-staging/` and `do-production/` overlays do this — `overlays/sipbridge`
+ `components/cloud-digitalocean` + a stable `do-loadbalancer-name`
(`pipecat-sip-staging` / `pipecat-sip-production`); production also layers
`env-production` for `:latest` images:

```bash
cd agents/pipecat/deploy/k8s
kubectl apply -k do-staging      # sipbridge + DO LB, name pipecat-sip-staging  (:next)
kubectl apply -k do-production   # + env-production, name pipecat-sip-production (:latest)
```

After the first apply, read the assigned IP and wire DNS / SBC ACLs to it — then
**never delete the Service** (the name pin keeps the IP across Service recreation,
but a deleted LB returns its IP to the pool):

```bash
kubectl get svc pipecat-sip -n pipecat -o wide   # EXTERNAL-IP is your stable IP
```

## Per-cloud notes

**GCP / GKE.** Public node pools get external IPs by default. `type:
LoadBalancer` provisions an external L4 network-passthrough LB (TCP) — exactly
what we want. Firewall:
```bash
gcloud compute firewall-rules create pipecat-sip-tls \
    --allow tcp:5061 --target-tags <node-pool-tag> --source-ranges <SBC_CIDRS>
gcloud compute firewall-rules create pipecat-rtp \
    --allow udp:10000-20000 --target-tags <node-pool-tag> \
    --source-ranges 0.0.0.0/0   # RTP media: direct from any source, not SBC-scoped
```
The worker can also pull provider keys from Secret Manager via
`GOOGLE_SECRETENV_PATH` (as in the VM deploy) instead of the `pipecat-secrets`
Secret — add it to `pipecat-config` and grant the nodes' SA access.

**AWS / EKS.** Run the SIP node group in a **public subnet with auto-assign
public IPv4** (or attach an EIP per node). Use `components/cloud-aws` (NLB,
`instance` target type). Open `TCP 5061` from the SBC ranges and `UDP 10000-20000`
(RTP media) from **all sources** in the node security group — we take direct media
from any source IP. Requires the AWS Load Balancer Controller.

**DigitalOcean / DOKS.** Worker droplets have public IPs by default. Use
`components/cloud-digitalocean` (TCP-mode LB), or the ready-made `do-staging` /
`do-production` overlays. DO can't pin a reserved IP to a managed LB, so the
overlays pin a stable `do-loadbalancer-name` and you wire DNS to the IP the LB is
assigned — see *Adding per-cloud LB annotations* above.

> **RTP firewall — do NOT edit the DOKS-managed firewall.** DOKS auto-manages a
> worker-node firewall (named `k8s-<cluster-uuid>`) and continuously reconciles
> it to mirror the cluster's Services. It opens `TCP 5061` (the LB), but the RTP
> range (`UDP 10000-20000`) flows **direct to each node's public IP**, bypassing
> the LB — it's not a Service, so DOKS never opens it, and any rule you add to the
> managed firewall by hand is **reverted**. This is not controllable from the
> kustomize overlay. Instead create your **own** Cloud Firewall (DO firewalls are
> additive; DOKS only touches its own) targeting the worker nodes by their DOKS
> tag, so it also survives node-pool scaling:
>
> ```bash
> doctl kubernetes cluster list      # note the cluster ID -> node tag k8s:<id>
> doctl compute firewall create \
>     --name pipecat-rtp \
>     --tag-names "k8s:<cluster-id>" \
>     --inbound-rules "protocol:udp,ports:10000-20000,address:0.0.0.0/0,address:::/0"
> ```
>
> (FreeSWITCH overlay uses `UDP 16384-16484` instead.) The RTP range is **open to
> all sources** (`0.0.0.0/0` + `::/0`): we take direct media from any source IP, so
> it is not source-scoped. (sipbridge only processes RTP on ports it negotiated per
> active call, so stray packets to the range are ignored.)

**imagePullSecret for Artifact Registry (EKS/DOKS):**
```bash
kubectl create secret docker-registry ar-pull -n pipecat \
    --docker-server=europe-west1-docker.pkg.dev \
    --docker-username=_json_key \
    --docker-password="$(cat ar-reader-key.json)"
kubectl patch serviceaccount default -n pipecat \
    -p '{"imagePullSecrets":[{"name":"ar-pull"}]}'
```

## How the external IP is detected

The `detect-ip` initContainer runs
[`scripts/detect-external-ip.sh`](base/scripts/detect-external-ip.sh), which
probes (first hit wins): **GCP metadata → AWS IMDSv2 → DigitalOcean metadata →
an HTTPS IP-echo fallback** (`EXT_IP_ECHO_URL`, default
`https://checkip.amazonaws.com`). The result is written to a shared volume at
`/etc/node-meta/ext-ip` and exported into the gateway's advertised SIP/media IP
at startup. If detection is wrong (e.g. nodes sit behind a SNAT gateway), pin it
explicitly by setting `NODE_EXT_IP` in `pipecat-config` — note this is a single
cluster-wide value, so only use it when every node shares one external IP.

Because **sipbridge ships as a distroless image with no shell**, a second
initContainer drops a static `busybox` into the shared volume; the sipbridge
container launches through it (`/etc/node-meta/busybox sh -c '…exec /sipbridge'`)
to expand the detected IP. No custom image is required. (If your policy forbids
exec-from-emptyDir, build an alpine-based `sipbridge/Dockerfile.k8s` with the
same wrapper baked in and point the overlay at it instead.)

## Choosing a gateway

- **sipbridge** (default) — TLS-native on 5061, self-signed fallback, UDP
  disabled, single static Go binary. Best fit for the TLS-only assumption.
- **freeswitch** — `overlays/freeswitch` adds FreeSWITCH + the esl-poller
  call-control sidecar (3 containers). TLS 5061 is preconfigured; **RTP range is
  16384-16484**, not 10000-20000 — open that range instead.
- **voiceblender** — `overlays/voiceblender`. Uses the third-party
  `ghcr.io/voiceblender/voiceblender` image; the node-IP wrapper assumes the
  binary is on `PATH` as `voiceblender`. Review `overlays/voiceblender/daemonset.yaml`
  before production use.

## TLS

All overlays listen for SIP over TLS on **5061**. With no cert provided, sipbridge
mints an ephemeral self-signed cert and FreeSWITCH uses a baked-in one — fine when
the SBC skips cert validation. For a real cert, create the `pipecat-sip-tls`
Secret (see `base/sip-tls-secret.example.yaml`); it is mounted optionally into the
gateway containers. For sipbridge, also uncomment `SIPBRIDGE_TLS_CERT_FILE/KEY_FILE`
in `overlays/sipbridge/daemonset.yaml`.

## WebRTC (browser clients)

Everything above is the SIP/telephony path. Browser WebRTC needs **three extra
things** the SIP wiring does not provide — the worker's HTTP API and its WebRTC
media must be reachable from the public internet, not just the SBC.

The flow: the browser calls the llm-agent server's `…/join`, gets back
`offerUrl = ${PIPECAT_PUBLIC_URL}/webrtc/offer?token=…`, and sends its SDP offer
**straight to the worker** (`:8082`). Media (SRTP/ICE) then flows **browser ⇄ the
answering node** directly. The offer is self-contained from the join token, so
any worker node can answer any offer (no session affinity).

**1. Public TLS endpoint — on the EXISTING SIP LB.** The base `pipecat-worker`
Service is ClusterIP (in-cluster only). Rather than a second LB, the
**`components/webrtc-do`** component (already wired into `do-staging` /
`do-production`) extends the existing `pipecat-sip` LB with a **443 → :8082**
TLS-terminated listener. DO runs both on one LB: `5061` stays TCP passthrough
(the gateway does its own SIP TLS); `443` terminates with a Let's Encrypt cert
and forwards plain HTTP to the worker. The LB keeps its IP (same Service/name) —
e.g. the staging LB at **134.209.137.127**.

llm-agent runs **off-cluster**, so point **both** `PIPECAT_PUBLIC_URL`
(browser → `/webrtc/offer`) and `PIPECAT_WORKER_URL` (server → `/dispatch`) at
`https://staging.pipecat.aplisay.net` — the only route to the worker. HTTPS is
mandatory (a browser on an HTTPS page can't POST to plain HTTP). The LB listens
on **443** (no port in the URL); to use `:8082` as the public port instead, set
`port: 8082` in `components/webrtc-do`.

> **Surface note:** putting `:8082` on the LB exposes *all* worker routes, not
> just `/dispatch` + `/webrtc/offer` (the SIP-internal `/freeswitch/events`,
> `/sipbridge/agent`, … are token-gated; `/daily/dialin` is unauthenticated but
> no-ops off a Daily gateway). Acceptable behind the per-endpoint tokens; to
> expose only the two paths, front with an Ingress (path allowlist) instead.

### Certificate — DO-managed Let's Encrypt

`pipecat.aplisay.net` is delegated to **DigitalOcean DNS**, so DO can DNS-validate
and issue a **managed Let's Encrypt cert that it auto-renews** — no certbot, no
uploads, no renewal job. Create one per environment and reference its ID:

```bash
# 1. DO provisions + auto-renews the LE cert (validates via the delegated zone):
doctl compute certificate create --type lets_encrypt \
    --name pipecat-staging --dns-names staging.pipecat.aplisay.net
doctl compute certificate list      # copy the cert's ID (UUID)

# 2. Put the ID in do-staging/kustomization.yaml -> do-loadbalancer-certificate-id,
#    then roll the LB (adds 443->8082 TLS, keeps 5061 + the IP 134.209.137.127):
kubectl apply -k do-staging
```

The A record (`staging.pipecat.aplisay.net` → 134.209.137.127) is already in place.
On the **llm-agent server** set `PIPECAT_PUBLIC_URL` = `PIPECAT_WORKER_URL` =
`https://staging.pipecat.aplisay.net`. **Production** is identical with
`production.pipecat.aplisay.net` + `do-production/` (its own cert).

> **Renewal is automatic** — DO renews the managed cert and the DOKS
> cloud-controller keeps the live LB pointed at it; no CronJob, no manual
> rotation. Treat the cert ID committed in `do-staging` as the *bootstrap*
> reference: if DO assigns a new ID at renewal, the CCM updates the live Service,
> so re-read the live value before re-committing rather than re-applying a stale
> one:
> ```bash
> kubectl get svc pipecat-sip -n pipecat -o \
>   jsonpath='{.metadata.annotations.service\.beta\.kubernetes\.io/do-loadbalancer-certificate-id}'
> ```

**2. WebRTC media UDP — a separate range.** You **cannot** reuse the SIP RTP
range (`10000-20000`): it's already bound by sipbridge on the same hostNetwork
node, so a second media handler would collide on those ports. (Both ranges are
open to all sources, so it's a port-collision constraint, not a firewall one.)
The worker's ICE layer (aioice) binds
**OS-ephemeral UDP ports** — there is no port-range knob — so open the node's
ephemeral range to browsers (default Linux `net.ipv4.ip_local_port_range` is
**32768-60999**):

```bash
doctl compute firewall create \
    --name pipecat-webrtc \
    --tag-names "k8s:<cluster-id>" \
    --inbound-rules "protocol:udp,ports:32768-60999,address:0.0.0.0/0,address:::/0"
```

(To narrow it you'd have to shrink `net.ipv4.ip_local_port_range` on the nodes via
sysctl — affects all node processes — or add a TURN relay. We use neither here.)

**3. STUN (no TURN).** The worker is configured with **Google public STUN** by
default (`WEBRTC_ICE_SERVERS` in `pipecat-config`, consumed at
`worker.py` → `SmallWebRTCConnection(ice_servers=…)`), so it advertises a
server-reflexive candidate (the node's public IP:port). On DigitalOcean the
public IP is already on the NIC so the host candidate also works; STUN matters on
GCP/AWS (public IP is 1:1-NAT'd off the NIC). No TURN — media is direct, which is
why step 2's UDP range must be open.

## Verification

```bash
# Renders cleanly (no cluster needed):
kubectl kustomize overlays/sipbridge | head

# One pod per labelled SIP node:
kubectl get pods -n pipecat -o wide

# External IP detected correctly per node:
kubectl logs -n pipecat ds/pipecat-sip -c detect-ip

# Gateway / worker health:
kubectl logs -n pipecat ds/pipecat-sip -c sipbridge
kubectl logs -n pipecat ds/pipecat-sip -c pipecat-worker

# LB address for the SBC to target on 5061/TLS:
kubectl get svc -n pipecat pipecat-sip
```

**No pods?** A DaemonSet only schedules on nodes matching its `nodeSelector`
(`aplisay.com/pipecat-sip=true`). If `kubectl get pods -n pipecat` is empty,
check the desired count and node labels:

```bash
kubectl get ds -n pipecat                       # DESIRED 0 = no labelled node
kubectl get nodes -L aplisay.com/pipecat-sip    # is any node labelled?
kubectl label nodes --all aplisay.com/pipecat-sip=true   # label them (test cluster)
```

**Fewer pods than nodes after a scale-up?** Same cause, quieter: the DaemonSet
looks healthy (all its pods Ready) and only `DESIRED` fails to grow, so nothing
alerts. It means the label is on the NODES rather than on the POOL, so nodes the
autoscaler added came up bare. Compare the two:

```bash
kubectl get nodes -L aplisay.com/pipecat-sip                  # which nodes have it
doctl kubernetes cluster node-pool list <cluster-id>          # does the POOL have it
```

Fix it at the pool (Prerequisites step 1) rather than re-labelling by hand —
otherwise it recurs on the next scale-up or node replacement. Node replacement is
the worse direction: capacity silently DROPS. Watch for it on the LB too, since
`externalTrafficPolicy: Local` means an unlabelled node has no local pod to serve
the tcp/5061 health check and shows up as an unhealthy backend.

If pods exist but stay in `Init:` or `ImagePullBackOff`, `kubectl describe pod
-n pipecat <pod>` shows why — commonly the private Artifact Registry images need
an `imagePullSecret` (see *imagePullSecret for Artifact Registry* above), or
`detect-ip` can't reach a metadata server (set `NODE_EXT_IP` in `pipecat-config`
for clusters with no cloud metadata).

End-to-end smoke test: point a test SBC at the LB address on **5061/TLS**, place a
call, and confirm two-way audio (RTP reaching the answering node's external IP).
Confirm the firewall scopes `TCP 5061` to your SBC ranges; the RTP/WebRTC media
UDP ranges are intentionally open to all sources (direct media from any source IP).

## Out of scope (follow-ups)

- **Autoscaling** — a DaemonSet scales with the node pool *provided the
  nodeSelector label is set on the POOL* (Prerequisites step 1); size the SIP
  pool for peak concurrent calls (each call uses 2 RTP ports).
- **Production secret backend** — only templates + guidance here; wire
  sealed-secrets / SOPS / External Secrets Operator for real deployments.
- **Dedicated k8s image pipeline** — the deploy reuses the existing Artifact
  Registry images built by [`../gcp/cloudbuild*.yaml`](../gcp).
- **GCS recording credentials** — if call recording is enabled, mount/identify a
  GCS service account (Workload Identity on GKE) for the worker.
