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
    sip-tls-secret.example.yaml # optional CA-signed TLS keypair template
    scripts/detect-external-ip.sh
    daemonset.yaml              # hostNetwork pod: initContainers + worker + volumes
    service-sip.yaml            # LoadBalancer, TCP 5061 (signalling)
    service-worker.yaml         # ClusterIP, 8082 (dispatch / control)
    kustomization.yaml
  components/                   # per-cloud LB annotations (layer onto an overlay)
    cloud-gcp/  cloud-aws/  cloud-digitalocean/
  overlays/                     # pick one
    sipbridge/                  # DEFAULT — TLS-only, UDP disabled, self-signed fallback
    freeswitch/                 # FreeSWITCH + esl-poller sidecar
    voiceblender/               # third-party image (see caveats)
```

## Prerequisites

1. **A dedicated SIP node pool** whose nodes have **public/external IPs** (or 1:1
   NAT) reachable by your SBCs, labelled so the DaemonSet lands only there:
   ```
   kubectl label node <node> aplisay.com/pipecat-sip=true
   ```
2. **Firewall** opened on those nodes, scoped to your SBC source ranges:
   - `TCP 5061` (SIP TLS)
   - `UDP 10000-20000` (RTP — sipbridge / voiceblender) **or** `UDP 16384-16484`
     (RTP — FreeSWITCH; see its `vars.xml`)
3. **Images** — the deploy pulls the same Artifact Registry images that
   [`../gcp/cloudbuild*.yaml`](../gcp) build:
   `europe-west1-docker.pkg.dev/llm-voice/containers/aplisay-pipecat-agent/{pipecat-worker,sipbridge,freeswitch,esl-poller}`.
   On GKE the nodes' service account can pull directly. On EKS/DOKS, add an
   imagePullSecret (below) or mirror the images to your own registry and override
   the tags via `kustomize edit set image`.
4. **Secrets** created in the namespace (next section).

## Quick start (sipbridge, the default)

```bash
cd agents/pipecat/deploy/k8s

# 1. Namespace (also created by the overlay, but handy for the secret first).
kubectl create namespace pipecat --dry-run=client -o yaml | kubectl apply -f -

# 2. Real secrets — copy the template, fill in values, apply. Generate the
#    per-stack tokens with: openssl rand -hex 32
cp base/secret.example.yaml /tmp/pipecat-secret.yaml   # edit /tmp/pipecat-secret.yaml
kubectl apply -n pipecat -f /tmp/pipecat-secret.yaml

# 3. (Optional) CA-signed TLS cert; otherwise the gateway self-signs.
# kubectl create secret tls pipecat-sip-tls -n pipecat \
#     --cert=fullchain.pem --key=privkey.pem

# 4. Apply the gateway overlay.
kubectl apply -k overlays/sipbridge

# 5. Verify (see "Verification" below).
```

`PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`, and `SHARED_API_TOKEN` **must
match the llm-agent server side**. Also set `SERVICE_BASE_URI` in
`base/configmap.yaml` to your environment's llm-agent REST base.

### Adding per-cloud LB annotations

The base `pipecat-sip` Service is a plain `type: LoadBalancer`. To apply
cloud-specific annotations (NLB on AWS, TCP mode on DO), make a thin local
overlay combining the gateway overlay with a cloud component:

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

## Per-cloud notes

**GCP / GKE.** Public node pools get external IPs by default. `type:
LoadBalancer` provisions an external L4 network-passthrough LB (TCP) — exactly
what we want. Firewall:
```bash
gcloud compute firewall-rules create pipecat-sip-tls \
    --allow tcp:5061 --target-tags <node-pool-tag> --source-ranges <SBC_CIDRS>
gcloud compute firewall-rules create pipecat-rtp \
    --allow udp:10000-20000 --target-tags <node-pool-tag> --source-ranges <SBC_CIDRS>
```
The worker can also pull provider keys from Secret Manager via
`GOOGLE_SECRETENV_PATH` (as in the VM deploy) instead of the `pipecat-secrets`
Secret — add it to `pipecat-config` and grant the nodes' SA access.

**AWS / EKS.** Run the SIP node group in a **public subnet with auto-assign
public IPv4** (or attach an EIP per node). Use `components/cloud-aws` (NLB,
`instance` target type). Open `TCP 5061` and `UDP 10000-20000` from the SBC
ranges in the node security group. Requires the AWS Load Balancer Controller.

**DigitalOcean / DOKS.** Worker droplets have public IPs by default. Use
`components/cloud-digitalocean` (TCP-mode LB). Attach a DO Cloud Firewall to the
SIP node pool allowing `TCP 5061` and `UDP 10000-20000` from the SBC ranges.

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

End-to-end smoke test: point a test SBC at the LB address on **5061/TLS**, place a
call, and confirm two-way audio (RTP reaching the answering node's external IP).
Confirm the firewall only exposes `TCP 5061` + the RTP UDP range to your SBC
ranges.

## Out of scope (follow-ups)

- **Autoscaling** — a DaemonSet scales with the node pool; size the SIP pool for
  peak concurrent calls (each call uses 2 RTP ports).
- **Production secret backend** — only templates + guidance here; wire
  sealed-secrets / SOPS / External Secrets Operator for real deployments.
- **Dedicated k8s image pipeline** — the deploy reuses the existing Artifact
  Registry images built by [`../gcp/cloudbuild*.yaml`](../gcp).
- **GCS recording credentials** — if call recording is enabled, mount/identify a
  GCS service account (Workload Identity on GKE) for the worker.
