# Desk phone provisioning on Kubernetes

Manifests for the provisioning service (`provisioning.mjs`). Desk phones
fetch their settings files from it. What the service does, and every
`PROV_*` setting, is in
[docs/phone-provisioning.md](../../../docs/phone-provisioning.md).

| Path | What |
|---|---|
| `base/` | The Deployment, its Service, its NetworkPolicy, its settings and the Snom CA file. Names no namespace. Not applied directly |
| `do-staging/` | The staging target: namespace, host name, certificate, load balancer, image |
| `publish-settings.sh` | Writes the service's own settings Secret |

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

## What the pod can reach

The same NetworkPolicy sets what the pod can open a connection to:

| To | Port | Why |
|---|---|---|
| The cluster's DNS (`kube-dns` in `kube-system`) | 53, UDP and TCP | To look up the database's name, when `POSTGRES_HOST` is a name |
| Any address outside the private ranges | 5432, TCP | The database |

Nothing else: no other pod or Service, no private address, and no other
port outside the cluster. Answers to a phone's own connection are not held
back.

How the list was found:

- By the code. In the files the service loads, three things open a
  connection of their own accord: the database pool, its listener and the
  start-up lock. All three go to the database. The other files that can
  open one do so only on the API server's paths (a model call, a list of
  voices, a call hook).
- By the settings. The pod's settings name no other service: the ConfigMap
  holds only `PROV_*`, `NODE_ENV` and `LOGLEVEL`, and the settings Secret
  takes only the names in the table below.
- By a run. The service was started with a note made of every connection
  it opened, then sent each kind of fetch, a certificate renewal and a
  restart. It opened connections to its database and looked up that
  database's name.

One more attempt shows in such a run: at each start the logging library
asks for Google's metadata server (169.254.169.254, port 80). The rule does
not admit it. The library gets no answer, gives up, and the service logs as
before.

The rule fits a database at a public address, which is where the staging
database is. For a database inside the cluster or on a private network, the
target must replace the second rule with one that names it. A target can
also narrow the second rule to the database's own address.

## What the pod needs

| Thing | Where it comes from |
|---|---|
| The namespace | It must exist. It is not in the kustomization, so `kubectl delete -k` leaves it |
| Secret `provisioning-secretenv` | `./deploy/k8s/provisioning/publish-settings.sh --env=<env>` (below) |
| Secret `provisioning-tls` | The target's cert-manager `Certificate` |
| The image pull Secret `aplisay-ar-pull` | Made by hand in the namespace. The registry is private |
| The database upgrade | `tools/agent-admin.js upgrade-db`. Without it the process exits at start |

The pod does not start until each Secret exists.

## The settings Secret

The service has a settings bundle of its own. It holds only the variables
the service reads.

```bash
./deploy/k8s/provisioning/publish-settings.sh --env=staging
```

- It reads `.env.<env>` at the root of the checkout it is run from, the same
  file the API server's bundle is made from. So the two cannot drift apart,
  and there is no second file of secrets. `--file=<path>` names another
  file.
- It writes the Secret `provisioning-secretenv` in the target's namespace,
  on the cluster bound to that environment. It asks before it writes.
  `--dry-run` writes nothing.
- It prints the names it bundled and the names it did not find. It never
  prints a value.
- The pod reads the Secret at start. Roll it after a publish.

What it takes from the file, and nothing else:

| Variable | Why |
|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | The database |
| `POSTGRES_CA`, `POSTGRES_CERT`, `POSTGRES_KEY`, `POSTGRES_RO_SERVER_NAME` | Its TLS, where it wants a client certificate: the server's CA, the client certificate and key, and the name on the server's certificate |
| `CREDENTIALS_KEY` | The phone's admin password is made from it. It must be the API server's |
| `PBX_REGISTRAR_DOMAIN`, `REGSERVER_REGISTRAR` | When a phone names a model other than the one typed, its lines are worked out again at the fetch, and a new line takes this name. Without it that fetch fails |
| `PBX_RELEASE` | Which phone system features are on, as on the API server |

The list is the `ONLY` line in `publish-settings.sh`. Each setting is there
by its exact name, the database's too. A setting the service comes to read
later must be added there.

Not in the list:

- `NODE_ENV` and `DB_FORCE_SYNC`: the manifests set the first, and the pod
  runs with the second unset.
- The `POSTGRES_POOL_*` settings. They are the API server's own, and the
  pod runs with the defaults: five connections at most.

The process decrypts the bundle at start, and a value in the bundle
replaces a value of the same name from the ConfigMap. The list holds no
`PROV_*` name, so the manifests' own settings stand.

`PROV_PUBLIC_URL` is set in the target. The API server needs the same value
in its own settings: it puts it in each phone's settings address.

The filter is `--only` of `deploy/bundle-secretenv.sh`. Another service can
use it the same way, with the Kubernetes target and a Secret name of its
own (`--k8s-secret`). `--only` does not write to the default Secret names,
which hold the bundle of the whole file.

## The image

The API server's image runs the service as it is: the manifests only change
the command to `node provisioning.mjs`. Run the build the environment's API
server runs. At start the service does the same start-up database work as
the API server, so a newer build would do a newer build's work first.

On staging that is `llm-agent-staging:staging`, which the staging build
pushes. The pull policy is `Always`, so the pod takes the newest build each
time its container starts: at a roll, and at any restart. After a staging
build, roll it, so it does not wait for its next restart:

```bash
kubectl --context=<cluster> -n b2bua rollout restart deployment/provisioning
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

## Staging

The staging name is `prov.sip-staging.aplisay.net`. It is inside the DNS
zone `sip-staging.aplisay.net`, which the cluster's `letsencrypt-dns` issuer
already serves. So the certificate needs no DNS or issuer work.

### A namespace that another repo owns

The target deploys into the namespace `b2bua`, beside the SIP edge and call
control. That namespace and everything else in it belong to the manifests
of the aplisay-b2bua repo. These manifests live here and only add to it:

- Every object here is named `provisioning`, or starts with it. No manifest
  of aplisay-b2bua uses such a name.
- The NetworkPolicy and the Service select the label
  `app.kubernetes.io/name: provisioning`, which only this pod has. A pod
  that no policy selects is not touched by it, so the other workloads stay
  as they are.
- The namespace already holds the pull Secret.
- **Take care with `kubectl delete -k` on an aplisay-b2bua target.** Some of
  them hold the Namespace itself. Deleting one of those removes the
  namespace, and with it this service, its Secrets and its load balancer.

### Before the first apply

1. **The settings Secret:**
   `./deploy/k8s/provisioning/publish-settings.sh --env=staging`.
2. **The database** is at the schema the image expects (the API server of
   the same build already runs on it).

### Apply

```bash
kubectl --context=<cluster> diff -k deploy/k8s/provisioning/do-staging
```

```bash
kubectl --context=<cluster> apply -k deploy/k8s/provisioning/do-staging
```

The apply makes a DigitalOcean load balancer named `prov-staging`, which is
charged for. Then:

1. Read the balancer's address:
   `kubectl -n b2bua get svc provisioning` (EXTERNAL-IP).
2. In the zone `sip-staging.aplisay.net`, add an A record `prov` with that
   address, TTL 300.
3. Wait for the certificate:
   `kubectl -n b2bua get certificate provisioning-tls` shows Ready. It does
   not wait for the A record.
4. Check from outside: `curl https://prov.sip-staging.aplisay.net/health`
   prints `ok`. A request for any settings file with no certificate gets a
   404 with an empty body.
5. Give the API server
   `PROV_PUBLIC_URL=https://prov.sip-staging.aplisay.net`. Until it has
   that, `POST /phones/{phoneId}/provision` answers 503 and no phone is
   given an address.

The address stays the same for as long as the Service exists. Deleting the
Service deletes the balancer, and a new one gets a new address: change the
A record then. To stop the service and keep the balancer:

```bash
kubectl --context=<cluster> -n b2bua scale deployment/provisioning --replicas=0
```

## A production target

There is none yet. Two things a production target must do differently from
the staging one:

- **Name a fixed build.** Staging follows the `:staging` tag, and takes the
  newest build at every start of its container. A production target must
  name the image by a release tag or a digest.
- **Use a database user of its own.** On staging the service signs in as
  the API server's database user. A production deployment needs a user for
  this service alone, with only the tables it reads and writes.

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
range that other pods share. Then only the NetworkPolicy limits which pods
reach the port. Check that the cluster's network plugin enforces it, for
pods on the host network too.
