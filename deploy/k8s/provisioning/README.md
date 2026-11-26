# Desk phone provisioning on Kubernetes

Manifests for the provisioning service (`provisioning.mjs`). Desk phones
fetch their settings files from it. What the service does, and every
`PROV_*` setting, is in
[docs/phone-provisioning.md](../../../docs/phone-provisioning.md).

| Path | What |
|---|---|
| `base/` | The Deployment, its Service, its NetworkPolicy, its settings and the Snom CA file. Not applied directly |
| `do-staging/` | The staging target: host name, certificate, load balancer, image |

## How a phone reaches it

A phone opens a TLS connection and presents its factory certificate. The
service ends TLS itself (`PROV_TLS_CERT_FILE`, `PROV_TLS_KEY_FILE`) and asks
for that certificate in the handshake. So everything between the phone and
the pod must pass TCP through untouched:

- The Service is a load balancer of its own that forwards TCP 443 to the
  pod's port 4010.
- The shared ingress is not used. It ends TLS, and as it is set up it
  cannot ask a client for a certificate and hand it on.
- The balancer must keep the phone's source address. The service counts
  refused requests for each address, and writes the address to the fetch
  log. Behind a balancer that hides it, every phone counts as one address.

The NetworkPolicy leaves only that port reachable. It is open to every
address, because the phones are anywhere.

## What the pod needs

| Thing | Where it comes from |
|---|---|
| The namespace `llm-agent` | `deploy/bundle-secretenv.sh --target=k8s` makes it. It is not in the kustomization, so `kubectl delete -k` leaves it |
| Secret `llm-agent-secretenv` | `deploy/bundle-secretenv.sh --env=<env> --target=k8s`, from the same environment file as the API server's bundle |
| Secret `provisioning-tls` | The target's cert-manager `Certificate` |
| The image pull Secret (`aplisay-ar-pull` on staging) | Made by hand in the namespace. The registry is private |
| The database upgrade | `tools/agent-admin.js upgrade-db`. Without it the process exits at start |

The pod does not start until each Secret exists.

From the settings bundle the service uses `POSTGRES_*` (with `POSTGRES_CA`,
`POSTGRES_CERT` and `POSTGRES_KEY` where the database wants a client
certificate) and `CREDENTIALS_KEY`. Both must be the API server's values:
the phone's admin password is made from `CREDENTIALS_KEY`.

The process decrypts the bundle at start, and **a value in the bundle
replaces a value of the same name from the ConfigMap**. So:

- `PROV_PUBLIC_URL` may be in both. The API server needs it too, so it is in
  the environment file anyway. Keep the two the same.
- Never put `PROV_TLS_*`, `PROV_CLIENT_CERT_HEADER`, `PROV_TRUSTED_PROXIES`,
  `PROV_PORT` or `PROV_SNOM_CA_FILE` in the environment file. They would
  replace what the manifests set.
- The pod holds every secret in the bundle, not only the ones it uses.

## The image

The API server's image runs the service as it is: the manifests only change
the command to `node provisioning.mjs`. Run the build the environment's API
server runs. At start the service does the same start-up database work as
the API server, so a newer build would do a newer build's work first.

On staging that is `llm-agent-staging:staging`, which the staging build
pushes. A running pod keeps the build it started with. After a staging
build, roll it:

```bash
kubectl --context=<cluster> -n llm-agent rollout restart deployment/provisioning
```

## The certificate

cert-manager renews the certificate 30 days before it ends. The service
reads its certificate files once, at start, so the manifests restart it:

- The container copies the certificate it is about to load to `/tmp`.
- The liveness probe compares that copy with the file on disk. After a
  renewal they differ, the probe fails, and the kubelet restarts the
  container, which loads the new certificate.

Expect one restart about every 60 days. Do not replace the liveness probe
with a plain HTTP probe.

## The Snom CA file

`base/snom-ca.pem` holds two public certificates, as Snom publishes them:

| Certificate | Source | SHA-256 fingerprint |
|---|---|---|
| Root, `snom technology AG SHA-256 CA` | `https://downloads.snom.com/documentation/ca-256.crt` | `74:6D:74:35:7F:0A:00:EC:C6:15:D5:95:14:FF:BA:DF:7C:AA:06:ED:8A:66:F3:3A:AE:A6:A1:A1:51:A2:1D:40` |
| Intermediate, `Snom Phone 1 SHA-256` | `https://downloads.snom.com/documentation/phone1-256.crt` | `AC:6B:0E:FA:80:C1:F9:2D:AE:01:AD:D8:4C:C8:CE:06:9E:45:DD:34:F7:A0:A2:54:B4:B2:DC:BB:D0:F4:DE:88` |

It reaches the pod as a generated ConfigMap. The root's fingerprint is the
one pinned in `lib/provisioning/server.js`: the service refuses to start on
a file whose root does not match. To check the file:

```bash
openssl x509 -in deploy/k8s/provisioning/base/snom-ca.pem -noout -fingerprint -sha256
```

That prints the first certificate, the root. Snom's page for these files
("TLS Support" on service.snom.com) lists the download addresses and prints
no fingerprints.

Snom's older root (`ca.crt`, SHA-1, a 1024-bit key) is left out on purpose.
A phone whose factory certificate is under it is refused. Snom lists the
models: among them the 710 and D710, D712, D715, D725, D745 and D765, unless
the unit was given a SHA-256 certificate later.

## Staging: before the first apply

The staging name is `prov-staging.aplisay.net`. In this order:

1. **The DNS zone.** `aplisay.net` is not a zone cert-manager can write to,
   so the name is a DigitalOcean zone of its own, as the staging registrar
   name is. Add the domain `prov-staging.aplisay.net` in DigitalOcean. In
   the `aplisay.net` zone, add an NS record set for `prov-staging` with
   `ns1.digitalocean.com.`, `ns2.digitalocean.com.` and
   `ns3.digitalocean.com.`. Check: `dig +short SOA prov-staging.aplisay.net`
   names `ns1.digitalocean.com`.
2. **The issuer.** The `letsencrypt-dns` ClusterIssuer has a DigitalOcean
   solver that lists the zones it serves. Add `prov-staging.aplisay.net` to
   that list. Its token already covers every domain of the account.
3. **The pull Secret** in the namespace `llm-agent`.
4. **The settings Secret:**
   `./deploy/bundle-secretenv.sh --env=staging --target=k8s`.
5. **The database** is at the schema the image expects (the API server of
   the same build already runs on it).

If the target is applied before steps 1 and 2, cert-manager asks for the
certificate, fails and tries again later, and the pod waits for the Secret.
Nothing else is harmed: the certificate holds only this name.

## Staging: apply

```bash
kubectl --context=<cluster> diff -k deploy/k8s/provisioning/do-staging
```

```bash
kubectl --context=<cluster> apply -k deploy/k8s/provisioning/do-staging
```

The apply makes a DigitalOcean load balancer named `prov-staging`, which is
charged for. Then:

1. Read the balancer's address:
   `kubectl -n llm-agent get svc provisioning` (EXTERNAL-IP).
2. Add an A record at the top of the `prov-staging.aplisay.net` zone with
   that address, TTL 300.
3. Wait for the certificate:
   `kubectl -n llm-agent get certificate provisioning-tls` shows Ready.
4. Check from outside: `curl https://prov-staging.aplisay.net/health`
   prints `ok`. A request for any settings file with no certificate gets a
   404 with an empty body.
5. Give the API server `PROV_PUBLIC_URL=https://prov-staging.aplisay.net`.
   Until it has that, `POST /phones/{phoneId}/provision` answers 503 and no
   phone is given an address.

The address stays the same for as long as the Service exists. Deleting the
Service deletes the balancer, and a new one gets a new address: change the
A record then. To stop the service and keep the balancer:

```bash
kubectl --context=<cluster> -n llm-agent scale deployment/provisioning --replicas=0
```

## Behind a proxy instead

Not built here, and not tested by us against a real proxy. If a proxy must
end TLS, it has to ask the phone for a certificate without checking it and
pass it on in a header:
[docs/phone-provisioning.md](../../../docs/phone-provisioning.md#behind-a-proxy)
has the rules. The manifests would change like this:

- Settings: `PROV_CLIENT_CERT_HEADER` and `PROV_TRUSTED_PROXIES` in place
  of `PROV_TLS_CERT_FILE` and `PROV_TLS_KEY_FILE`. No certificate volume, no
  copy at start, plain HTTP probes.
- The Service stays a ClusterIP.
- The NetworkPolicy must let only the proxy's pods reach the port:

  ```yaml
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: <the proxy's namespace>
          podSelector:
            matchLabels:
              <the proxy's pod labels>
      ports:
        - protocol: TCP
          port: https
  ```

A proxy's pod addresses change, so `PROV_TRUSTED_PROXIES` would have to be a
range that other pods share. Then the NetworkPolicy is the only thing that
stops another pod from sending the header. Check that the cluster's network
plugin enforces it, for pods on the host network too.
