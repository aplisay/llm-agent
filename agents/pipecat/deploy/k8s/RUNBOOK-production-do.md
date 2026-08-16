# Production deploy runbook — Pipecat agent on DigitalOcean (lon1)

End-to-end, verified procedure to bring the Pipecat SIP/WebRTC agent up on the
**production** DOKS cluster, mirroring the working **staging** deploy but fixing
the gaps staging has. Read this alongside [`README.md`](README.md) (architecture
+ rationale) and [`RUNBOOK-cutover.md`](RUNBOOK-cutover.md) (the LB-type / IP
cutover mechanics). **This runbook supersedes the cutover runbook's ordering**
because it adds the steps the cutover doc assumes are already done — chiefly
*building the `:latest` images*.

> Status when this was written (verified live against both clusters):
> production is **greenfield** — no `pipecat` namespace, no secrets, no node
> labels, no LB/cert/DNS/firewalls, and **no `:latest` images published**.
> Everything below is a fresh bring-up.

---

## 0. Facts (verified live)

| | Staging (reference, LIVE) | Production (TARGET, greenfield) |
|---|---|---|
| kubectl context | `do-ams3-k8s-1-36-0-do-1-ams3-1780735847909` | `do-lon1-k8s-1-36-0-do-2-lon1-1782604340196` |
| DO cluster id | `51e21669-564d-41da-b5fb-26a7c26e127a` | `76c8a432-7d14-4946-b667-e71078bd60bb` |
| Node firewall tag | `k8s:51e21669-564d-41da-b5fb-26a7c26e127a` | `k8s:76c8a432-7d14-4946-b667-e71078bd60bb` |
| Region | ams3 | lon1 |
| SIP node pool | `pool-741oen40n` (1 node, pool-labelled) | `llm-voice-prod` (2 nodes, pool-labelled 2026-08-15; autoscales 2→5) |
| Node external IPs | 164.92.154.188 | 138.68.185.22, 138.68.162.72 |
| Overlay | `do-staging` | `do-production` |
| Gateway | sipbridge (RTP **10000-20000**) | sipbridge (RTP **10000-20000**) |
| LB | `pipecat-sip-staging` = **134.209.137.127** (REGIONAL, active) | none yet |
| Cert | `pipecat-staging` (verified) `b0d6588d-…` | none yet |
| DNS | `staging.pipecat.aplisay.net → 134.209.137.127` | none yet |
| FQDN | `staging.pipecat.aplisay.net` | `production.pipecat.aplisay.net` |

`pipecat.aplisay.net` is a **DO-managed DNS zone** (ns1/2/3.digitalocean.com), so
DO can DNS-validate the Let's Encrypt cert and we manage the A record with `doctl`.

### What the `do-production` overlay actually does

`kubectl kustomize do-production` renders identically to live staging **except**
three intended diffs:

1. images pinned `:latest` (via `components/env-production`) instead of `:next`;
2. `do-loadbalancer-name: pipecat-sip-production` (its own stable LB);
3. `do-loadbalancer-certificate-id: REPLACE_WITH_PRODUCTION_DO_CERT_ID` ← **must be replaced**.

The overlay is **cluster-agnostic** — it pins no cluster. "Deploy to lon1" simply
means run `kubectl apply -k do-production` with the **lon1 context current** (or
`--context do-lon1-…`). The only in-repo edit required is the cert ID (step 2).

---

## 1. Blockers found in the current state (fix before/at deploy)

These are the things that will silently break a naïve `kubectl apply -k do-production`:

1. **`:latest` images don't exist.** AR has only `next`, `staging`, and per-commit
   SHA tags for `pipecat-worker`, `sipbridge`, `secretenv-exec`. Apply-as-is →
   `ImagePullBackOff` on every container. **Run the production cloudbuild first** (step 0).
2. **Cert placeholder.** `REPLACE_WITH_PRODUCTION_DO_CERT_ID` is still in the
   overlay. Apply with it → the DO LB drops the 443 TLS listener (SIP 5061 still
   works → *silent partial failure*; WebRTC/dispatch unreachable over HTTPS).
3. **Prod nodes are unlabelled.** DaemonSet `nodeSelector: aplisay.com/pipecat-sip=true`
   — and the label belongs on the node POOL (Step 6), or it is lost on every
   autoscale and node replacement.
   Apply without labelling → DaemonSet `DESIRED=0`, **no pods**, no Service
   endpoints → with `externalTrafficPolicy: Local` the LB health check (tcp/5061)
   fails on every node → the LB gets an IP but **both 5061 and 443 are dead**.
4. **No namespace / pull secret / secretenv bundle.** Without `ar-pull` on the
   `default` SA → image pull 401. Without the `pipecat-secretenv` bundle → the
   worker/gateway run misconfigured. The namespace must carry
   `pod-security.kubernetes.io/enforce=privileged` or the hostNetwork pods are
   admission-rejected — `bundle-secretenv.sh` creates it correctly; a bare
   `kubectl create namespace` does **not**.
5. **No RTP/WebRTC firewalls.** Media flows direct to node public IPs, bypassing
   the LB; DOKS only opens intra-VPC traffic. Without custom firewalls, media is
   dropped at the cloud edge (no logs). Create both for prod (step 11). **Both
   are open to all sources** (`0.0.0.0/0` + `::/0`) — we take direct media from
   any source IP, so neither RTP nor WebRTC is source-scoped.
6. **Per-env config in the bundle.** The shared ConfigMap ships placeholders
   (`SERVICE_BASE_URI: https://api.aplisay.example`, empty `PIPECAT_SIP_OUTBOUND`).
   Production values must go in the **secretenv bundle**, which overrides the
   ConfigMap at container start (envFrom precedence: ConfigMap then Secret).

---

## 2. Inputs you must gather first

- **DO API token** with **both `certificate` and `domain`** scopes (cert issuance
  DNS-validates against the delegated zone; without `domain` it silently 403s).
- **GCP Artifact Registry reader key** JSON (a GCP SA key with read on
  `europe-west1-docker.pkg.dev/llm-voice`) for the `ar-pull` secret.
- **Production token triad** — `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`,
  `SHARED_API_TOKEN`. These must be **identical** in the worker's secretenv
  bundle and on the production llm-agent server. Generate fresh for prod
  (`openssl rand -hex 32`); do **not** reuse staging's.
- **Production llm-agent REST base** → goes in the bundle as `SERVICE_BASE_URI`.
- Decision: outbound calling / WebRTC→telephony transfer in prod? If yes you also
  need `PIPECAT_SIP_OUTBOUND`, `PIPECAT_SIP_FROM_DOMAIN`, `PIPECAT_SIP_USERNAME/PASSWORD`.

---

## 3. Ordered procedure

All `kubectl` below assume `--context do-lon1-k8s-1-36-0-do-2-lon1-1782604340196`
(or `kubectl config use-context …` once). `doctl` acts on the account globally.

### Step 0 — Publish the `:latest` images (NOT in the old runbook)

The production cloudbuild is tag-triggered, not automatic on `main`.

```bash
# from repo root, gcloud configured for project llm-voice:
gcloud builds submit --config agents/pipecat/deploy/gcp/cloudbuild.yaml \
    --substitutions LOCATION=europe-west1 .
# confirm the tags now exist (each must print 'latest'):
for img in pipecat-worker sipbridge secretenv-exec; do
  echo "$img:"; gcloud artifacts docker tags list \
    europe-west1-docker.pkg.dev/llm-voice/containers/llm-agent/$img \
    --format='value(tag)' | grep -xE 'latest' || echo "  MISSING latest"; done
```

### Step 1 — Issue the production TLS cert (no outage risk)

```bash
doctl compute certificate create --type lets_encrypt \
    --name pipecat-production --dns-names production.pipecat.aplisay.net
# poll until State = verified, copy the ID:
doctl compute certificate list --format ID,Name,DNSNames,State --no-header
```

### Step 2 — Paste the cert ID into the overlay

Edit `agents/pipecat/deploy/k8s/do-production/kustomization.yaml` — replace
`REPLACE_WITH_PRODUCTION_DO_CERT_ID` with the verified cert UUID. Sanity-render:

```bash
kubectl kustomize do-production | grep -A14 'name: pipecat-sip$'
# expect: real cert-id, do-loadbalancer-name=pipecat-sip-production,
#         do-loadbalancer-type=REGIONAL, tls-ports 443, ports 5061 + 443->8082
```

### Step 3 — Build the production secret source

```bash
cp agents/pipecat/env-example-k8s agents/pipecat/.env.production   # git-ignored
${EDITOR:-vi} agents/pipecat/.env.production
```

Fill the **SECRETS** block (the prod token triad = the prod server's values;
provider API keys; `SIPBRIDGE_API_TOKEN`; SIP digest creds if outbound). Uncomment
the **per-env config overrides** you need: `SERVICE_BASE_URI` (prod llm-agent REST
base) and, for outbound, `PIPECAT_SIP_OUTBOUND` + `PIPECAT_SIP_FROM_DOMAIN`.
**Do NOT set** `EXT_IP_ADDRESS` / `SIPBRIDGE_SIP_SIGNAL_IP` / `SIPBRIDGE_MEDIA_IP`
(auto-detected per node) or `PIPECAT_PUBLIC_URL` / `PIPECAT_WORKER_URL`
(server-side, not the worker).

### Step 4 — Namespace + secretenv bundle (creates the privileged ns)

```bash
kubectl config use-context do-lon1-k8s-1-36-0-do-2-lon1-1782604340196
cd agents/pipecat/deploy/k8s
# NB --env=production has no cluster binding in the bundler (staging->AMS3 and
# beta->LON1 are the only two), so name this cluster explicitly:
../bundle-secretenv.sh --env=production \
    --k8s-context=do-lon1-k8s-1-36-0-do-2-lon1-1782604340196  # creates ns (PSA privileged) +
                                             # pipecat-secretenv-production + alias
```

> Must run **before** apply, and **must** be this script (not a bare
> `create namespace`) so the namespace gets the `enforce=privileged` PSA label.
> Needs `node`/`npx`/`openssl` + GitHub access (pulls `rjp44/secretenv#v1.0.5`).

### Step 5 — Registry pull secret + SA patch

```bash
kubectl -n pipecat create secret docker-registry ar-pull \
    --docker-server=europe-west1-docker.pkg.dev \
    --docker-username=_json_key \
    --docker-password="$(cat /path/to/ar-reader-key.json)"
kubectl -n pipecat patch serviceaccount default \
    -p '{"imagePullSecrets":[{"name":"ar-pull"}]}'
```

### Step 6 — Label the SIP node POOL (else 0 pods)

```bash
doctl kubernetes cluster node-pool update 76c8a432-7d14-4946-b667-e71078bd60bb \
    llm-voice-prod --label aplisay.com/pipecat-sip=true
```

(Every node in the pool → HA: one DaemonSet pod each, each advertising its own
public IP for media; the LB spreads 5061 across all of them.)

> Label the **POOL**, not the nodes. A pool label is stamped on every node DOKS
> creates from then on; `kubectl label node …` only marks the nodes that exist at
> that moment. This pool autoscales 2→5, so hand-labelling means an autoscaled
> node runs no SIP pod (`DESIRED` just stays put — nothing alerts), and a node
> replaced by an upgrade or auto-repair takes SIP capacity down with it. That is
> exactly what happened here: the pool was labelled only at the node level and
> was corrected on 2026-08-15. Pool labels apply to NEW nodes, so if the existing
> nodes were never labelled by hand, recycle them after setting it.

### Step 7 — Apply

```bash
cd agents/pipecat/deploy/k8s
kubectl apply -k do-production
```

### Step 8 — Read the LB IP and VERIFY ITS TYPE *before* wiring DNS

```bash
kubectl -n pipecat get svc pipecat-sip -o wide -w     # ctrl-C when EXTERNAL-IP appears
LB=$(kubectl -n pipecat get svc pipecat-sip \
  -o jsonpath='{.metadata.annotations.kubernetes\.digitalocean\.com/load-balancer-id}')
doctl compute load-balancer get "$LB" --format Type,IP,Status,ForwardingRules --no-header
```

**Expect `Type REGIONAL`**, `443→https→<nodePort>` with the cert, `5061→tcp→<nodePort>`.
If it came up `REGIONAL_NETWORK` (DOKS CCM default in some regions), 443 TLS will
**not** terminate — `kubectl delete svc pipecat-sip -n pipecat` and re-apply to
recreate as REGIONAL (yields a **new IP**). Do this **now**, before DNS, so you
never orphan a record. After this, the `do-loadbalancer-name` pin keeps the IP
stable — **never delete the Service again** (see Rollback).

### Step 9 — DNS

```bash
doctl compute domain records create pipecat.aplisay.net \
    --record-type A --record-name production --record-data <PROD_LB_IP> --record-ttl 900
```

> New `production` record only. **Do not** touch the apex `@` or `staging` records
> (both currently 134.209.137.127, the staging IP).

### Step 10 — llm-agent server (off-cluster)

On the **production** llm-agent server set:

```
PIPECAT_PUBLIC_URL = PIPECAT_WORKER_URL = https://production.pipecat.aplisay.net
PIPECAT_DISPATCH_TOKEN / PIPECAT_JOIN_SECRET / SHARED_API_TOKEN  = the bundle's values
```

then restart it. (`pipecat-worker` is ClusterIP-only; the **only** route from an
off-cluster server to the worker is the 443 listener on the SIP LB — which is why
`webrtc-do` is required, not optional, and why `PIPECAT_WORKER_URL` is the public
HTTPS FQDN, not an in-cluster Service URL.)

### Step 11 — Firewalls (media)

```bash
# SIP RTP — sipbridge range 10000-20000. Open to all sources: we take direct
# media from any source IP, so the RTP range is NOT source-scoped:
doctl compute firewall create --name pipecat-rtp-prod \
    --tag-names k8s:76c8a432-7d14-4946-b667-e71078bd60bb \
    --inbound-rules "protocol:udp,ports:10000-20000,address:0.0.0.0/0,address:::/0"

# WebRTC browser media — ephemeral UDP, also world-open (browsers come from anywhere):
doctl compute firewall create --name pipecat-webrtc-prod \
    --tag-names k8s:76c8a432-7d14-4946-b667-e71078bd60bb \
    --inbound-rules "protocol:udp,ports:32768-60999,address:0.0.0.0/0,address:::/0"
```

> TCP 5061 and 443 reach the nodes automatically via the LB over the private VPC
> (the DOKS-managed worker firewall permits intra-VPC) — **no manual node rule for
> 5061**. **Do not edit the DOKS-managed firewalls** (`k8s-…-worker`,
> `k8s-public-access-…`); DOKS reverts manual changes. Firewalls bind to the node
> **tag**, so they cover future nodes too — but re-verify attachment after any
> node-pool replacement (a tag change silently detaches them).
> The WebRTC range assumes the Linux default `net.ipv4.ip_local_port_range`
> (32768-60999); confirm it on the nodes if media misbehaves.

---

## 4. Verification

```bash
C=do-lon1-k8s-1-36-0-do-2-lon1-1782604340196
kubectl --context $C get ds pipecat-sip -n pipecat -o wide        # DESIRED=2 CURRENT=2 READY=2
kubectl --context $C get pods -n pipecat -o wide                  # 2 pods, 2/2 Running
kubectl --context $C get ns pipecat \
  -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}{"\n"}'   # privileged
kubectl --context $C get sa default -n pipecat -o jsonpath='{.imagePullSecrets}{"\n"}'  # ar-pull
kubectl --context $C get endpoints pipecat-sip -n pipecat         # has node IPs (not empty)
kubectl --context $C logs ds/pipecat-sip -n pipecat -c detect-ip  # detected each node's IP
dig +short production.pipecat.aplisay.net A                       # == prod LB IP (not 134.209.137.127)
curl -vkI https://production.pipecat.aplisay.net/ 2>&1 | grep -Ei 'subject:|HTTP/|server:'
#   -> HTTP/2 404, server: uvicorn  == TLS terminated at LB + forwarded to worker (SUCCESS)
```

Then a **live SIP call** (two-way RTP to a node's public IP) and a **real browser
WebRTC join**. SIP success alone does **not** prove WebRTC media — that needs the
step-11 WebRTC firewall.

---

## 5. Rollback / abort

- **Before DNS is wired (step 9):** safe to `kubectl delete -k do-production` (or
  delete the Service) and retry — nothing points at the LB IP yet.
- **After DNS/SBC point at the LB IP:** **never delete the `pipecat-sip` Service.**
  The `do-loadbalancer-name` pin keeps the IP only while the Service exists;
  deleting it returns the IP to DO's pool and the recreate gets a **new IP →
  outage**. To roll back, repoint DNS/SBC/`PIPECAT_*` and roll pods, not the LB.
- Rotate a secret: edit `.env.production`, re-run `../bundle-secretenv.sh
  --env=production`, then `kubectl rollout restart daemonset/pipecat-sip -n pipecat`.

---

## 6. Known gaps to track (carried from staging)

- **RTP/WebRTC firewalls are intentionally world-open** (`0.0.0.0/0` + `::/0`) —
  we take direct media from any source IP, so the media ranges are deliberately
  not source-scoped. (Supersedes the older generic "scope RTP to SBC ranges"
  advice; staging's `RTP` firewall being world-open is correct, not a gap.)
- **WebRTC media firewall** — staging was missing it (public browser-WebRTC media
  blocked at the cloud edge); **backfilled 2026-06-28** as `pipecat-webrtc-staging`
  (udp 32768-60999, world-open, on the staging cluster tag). Prod creates its own
  `pipecat-webrtc-prod` in step 11.
- **README cites the old staging LB IP `129.212.220.15`** (now 134.209.137.127) —
  fixed in this change; mentioned here so the discrepancy is on record.
- **`webrtc-do` exposes all worker routes** on 443 (token-gated except the
  Daily-only `/daily/dialin` no-op). For tighter prod surface, front with an
  Ingress path allowlist instead of the LB 443 listener.
