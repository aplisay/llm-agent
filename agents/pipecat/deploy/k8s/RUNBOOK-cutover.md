# DigitalOcean LB cutover runbook (pipecat-sip)

How to bring up — or migrate — the `pipecat-sip` LoadBalancer on DigitalOcean so
that **5061** is SIP/TLS passthrough and **443** is a DO-managed-cert HTTPS
endpoint for WebRTC (`/webrtc/offer`, `/dispatch`) forwarding to the worker on
`:8082`.

## Why this is a runbook and not just `kubectl apply`

A DO **network** LB (`type: REGIONAL_NETWORK`) is pure L4 passthrough and
**cannot terminate TLS** — it silently ignores `do-loadbalancer-tls-ports` /
`-certificate-id`, leaving 443 as a raw `tcp` rule with no cert. Only a
**standard** LB (`type: REGIONAL`) terminates TLS *and* TCP-passes-through 5061.

The DOKS CCM has defaulted new LBs to `REGIONAL_NETWORK` in our region, so the
`cloud-digitalocean` component now pins `do-loadbalancer-type: REGIONAL`
explicitly. **DO cannot change an LB's type in place** — migrating an existing
`REGIONAL_NETWORK` LB means delete + recreate, which assigns a **new IP**
(reserved IPs can't attach to managed LBs). That IP change is the disruptive
part this runbook sequences.

The forwarding rules you want afterwards (target ports are nodePorts — that's
correct for a standard LB fronting a Service, *not* a bug):

```
entry_protocol:https, entry_port:443,  target_protocol:http, target_port:<nodePort>, certificate_id:<cert>
entry_protocol:tcp,   entry_port:5061, target_protocol:tcp,  target_port:<nodePort>
```

---

## Pre-flight (non-disruptive — do before any window)

Run against the **target cluster context** (`kubectl config use-context <ctx>`).

1. **Issue the DO-managed Let's Encrypt cert** (`pipecat.aplisay.net` is delegated
   to DO, so DO issues + auto-renews):

   ```bash
   # staging:
   doctl compute certificate create --type lets_encrypt \
     --name pipecat-staging --dns-names staging.pipecat.aplisay.net
   # production:
   doctl compute certificate create --type lets_encrypt \
     --name pipecat-production --dns-names production.pipecat.aplisay.net

   # poll until State = verified:
   doctl compute certificate list --format ID,Name,DNSNames,Type,State --no-header
   ```

   > The DO API token needs **both** `certificate` *and* `domain` scopes, else
   > issuance 403s.

2. **Paste the cert ID into the overlay** (`do-staging/` or `do-production/`
   `kustomization.yaml`, the `do-loadbalancer-certificate-id` op). A placeholder
   makes the DO LB reject the 443 listener.

3. **Cluster prerequisites:**

   ```bash
   kubectl get ns pipecat                                   # namespace exists
   kubectl get secret -n pipecat ar-pull pipecat-secretenv  # pull + secretenv secrets
   kubectl get nodes -l aplisay.com/pipecat-sip=true        # SIP nodes labelled
   ```

   Confirm the right secretenv bundle is loaded for the env
   (`SECRETENV_PIPECAT_{staging|production}_*`).

4. **Pre-check the existing LB type** — decides whether the window is a hard IP
   cutover:

   ```bash
   LB=$(kubectl get svc pipecat-sip -n pipecat \
     -o jsonpath='{.metadata.annotations.kubernetes\.digitalocean\.com/load-balancer-id}' 2>/dev/null)
   [ -n "$LB" ] && doctl compute load-balancer get "$LB" --format Type,IP --no-header || echo "no LB yet"
   ```

   - `REGIONAL_NETWORK` → IP **will change**; follow the delete+recreate path.
   - `REGIONAL`, or no LB yet → `apply` is non-destructive; skip the delete.

---

## Cutover (maintenance window if the IP changes)

```bash
# (a) ONLY if the existing LB is REGIONAL_NETWORK — deletes the LB, drops the IP:
kubectl delete svc pipecat-sip -n pipecat

# (b) create / recreate as a standard LB (staging => :next, production => :latest)
kubectl apply -k do-staging          # or: kubectl apply -k do-production

# (c) wait for the new EXTERNAL-IP
kubectl get svc pipecat-sip -n pipecat -o wide -w     # ctrl-C once IP appears

# (d) verify the LB is standard + rules are right
LB=$(kubectl get svc pipecat-sip -n pipecat \
  -o jsonpath='{.metadata.annotations.kubernetes\.digitalocean\.com/load-balancer-id}')
doctl compute load-balancer get "$LB" --format Type,IP,Status --no-header
doctl compute load-balancer get "$LB" --format ForwardingRules --no-header
```

**Expect:** `Type REGIONAL`; `443 → https → <nodePort>` with the cert ID;
`5061 → tcp → <nodePort>`. (`target_port` is a Service nodePort — normal.)

---

## Cut traffic over (only if the IP changed)

1. **DNS** — A record `{staging|production}.pipecat.aplisay.net` → new IP.
2. **SBC** — 5061 next-hop / DNS → new IP.
3. **llm-agent env** — `PIPECAT_PUBLIC_URL=https://{staging|production}.pipecat.aplisay.net`
   (redeploy/restart to pick it up).
4. **Firewall** — the DO Cloud Firewall is attached to the SIP **node pool**, not
   the LB, so the RTP UDP range + TCP 5061 rules survive the LB recreate — just
   confirm they're present.

---

## Verify

```bash
# direct to the new IP (works before DNS propagates):
curl -vkI https://<new-IP>/                              # TLS handshake + uvicorn 404 on /
# via FQDN once DNS flips:
curl -vkI https://{staging|production}.pipecat.aplisay.net/
```

A `404 Not Found` from `server: uvicorn` on `/` is the **success** signal — `/`
isn't a route; it proves TLS terminated at the LB and forwarded to the worker.
Finish with a real browser WebRTC join.

**Rollback:** repoint DNS/SBC to the old IP — but a deleted LB is gone, so once
you run the `delete`, forward is the only way. Keep the window tight.
