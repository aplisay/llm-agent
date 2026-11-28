# Desk phone provisioning

A desk phone of the [phone system](phone-system.md) fetches its settings file from the provisioning service. The file gives the phone one SIP identity for each of its lines. Nobody types an account into a phone.

Snom D7xx phones are supported. The service is a process of its own, apart from the API server.

## How a phone gets its settings

1. Add the phone with `POST /phones` (MAC address, model, the people it rings for).
2. `POST /phones/{phoneId}/provision` returns the phone's settings address once: `https://<host>/snom/<secret>/{mac}.xml`. It needs `phone:provision`. The platform keeps only a hash of the secret part.
3. Point the phone at that address (its Setting URL, or a redirect service).
4. The phone fetches the file over TLS and presents its factory certificate.
5. The phone applies the file and registers each line.

The address alone opens nothing. A file is served only when all of these hold:

- The address names a phone that is not wiped or removed.
- The file name carries that phone's MAC address.
- The phone presented a certificate that chains to a pinned root of the vendor's CA.
- The MAC address in the certificate's common name is the phone's.
- The certificate is the one that fetched first. A different certificate for the same MAC is refused.
- The address was first used before it expired (7 days after it was made).

Every refusal is a 404 with an empty body, so an address that names no phone looks the same as a refused one.

## The fetch log and the limit

A request whose address names a phone is written to `device_fetch_logs` with its result. A request that names no phone is only counted, and the count is logged once a day. Rows are deleted after `PROV_FETCH_LOG_DAYS` days (default 90) by a purge the service runs once a day.

Refused requests are counted for each source address. After 30 in one minute, every request from that address is refused for the rest of the minute, and one row with the result `rate_limited` is written. Served requests never count, so many phones behind one address are not held back.

## Zero touch with Snom's redirection service

A factory-reset Snom phone asks Snom's redirection service (SRAPS) where to fetch its settings. With an SRAPS company API token set, `POST /phones/{phoneId}/provision` also tells SRAPS the phone's settings address, so the phone finds it with nobody touching it.

| Variable | Use |
|---|---|
| `SNOM_SRAPS_KEY_ID` | The access key id of the company API token |
| `SNOM_SRAPS_KEY_SECRET` | Its secret |
| `SNOM_SRAPS_COMPANY_ID` | The SRAPS company the phones are added to |

Set them on the API server. With any of them unset nothing is sent to Snom.

A binding is made in the name of the platform's SRAPS company, so a platform operator decides which organisations may make one. Give the organisation the `phoneRedirect` capability with `PUT /organisations/{id}/capabilities`. Only a platform operator can give or take it, and it cannot be a brand default. For any other organisation nothing is sent, and `redirect.error` is `not_allowed`. Taking the capability away leaves the phones that are already bound as they are. A wipe or a removal still releases them: a release needs no capability. A caller that is not a platform operator cannot take the capability away: it is kept whatever list that caller sends.

- The answer of the provision route has `redirect`: `{ service, bound }`. When `bound` is false, `error` says why, and the address can still be typed into the phone.
- `mac_taken` means another SRAPS company holds the phone. The phone then shows the failure `other_provider`. Only Snom or that company can free it.
- A bound address lasts 30 days before its first use, not 7.
- `GET /phones/{phoneId}/redirect` asks SRAPS what it holds, and when the phone last called in.
- A wipe or a removal takes the phone out of SRAPS again. If SRAPS cannot be reached then, the API server tries again once a day. If the phone has since been added and bound again, the old record is dropped and the new binding is left alone.
- SRAPS holds the phone's whole settings address, for up to 30 days before its first use. The address alone opens nothing: the phone's certificate is what is checked.
- `clock_skew` means this server's clock is more than a minute from Snom's, so every signed call is refused. Fix the clock.
- SRAPS is asked only at a factory reset. A new address does not reach a phone that is already running.

The adapter has been tested against a stand-in service only, not against Snom.

## What the file holds

A key on the phone's first page that has no line is cleared.

For each line: `user_name`, `user_pname`, `user_hash`, `user_host`, `user_outbound` (TLS), SRTP required, and a `line` key with the line's label. `user_hash` is the digest hash of the line's account. `user_pass` is empty: the file never holds a password, and neither does the database.

The file also locks the phone's settings address, switches its web interface to HTTPS, and sets its admin and web password. That password is made from `CREDENTIALS_KEY` and the phone's id, and is stored nowhere. With `CREDENTIALS_KEY` unset it is random at each fetch.

The file does not pin a firmware version.

## The phone's model

The phone names its model when it fetches. If that differs from the model that was typed, the reported model wins and the phone's lines are worked out again. A model that is not supported is refused, and the phone shows the failure `model_not_supported`. When the request names no model, the model on the phone's row decides.

The supported models are the Snom D713, D717, D735 and D785, and the Snom 710 for testing (see below). The D7xx models leave the factory with their own SHA-256 certificate under Snom's SHA-256 CA.

A model can be in the catalogue as not supported (`supported: false` in `lib/pbx/phone-models.js`). Then:

- `POST /phones` and a change of model refuse it: 400, code `model_not_supported`.
- A phone of that model that is already in a directory still lists, with its lines. `POST /phones/{phoneId}/provision` refuses it: 409, code `model_not_supported`. Its fetches are refused with `model_not_supported`, which the phone then shows as its failure.
- If the model was typed wrongly, change it with `PATCH /phones/{phoneId}` and provision again. A phone that has reported its model cannot be changed: remove it.

### Models with a built-in SHA-1 certificate

Older Snom models, among them the 710, D712, 715, D725, D745 and D765, leave the factory with a SHA-1 certificate under Snom's older CA. The service refuses such a certificate (`certificate_untrusted` in the fetch log), and that does not change: the older CA is not trusted.

Snom's documentation describes an upgrade that gives such a phone its own SHA-256 certificate (the "Upgrade to SHA-2" section of Snom's TLS Support page). A phone of these models needs that upgrade, and must present its SHA-256 certificate, before it can fetch from this service.

### The Snom 710

The 710 is in the catalogue as supported so that it can be tested. It can be added and given a settings address. It is not yet proved on a real phone:

- A 710 that presents its factory certificate is refused with `certificate_untrusted`, as above.
- A 710 with Snom's SHA-2 upgrade that presents its SHA-256 certificate should be served. This has not been tested.

The 710 may be taken out of the supported models again. **Decide before a production release whether it stays.** To take it out, set its entry to `supported: false`: the rules above for a model that is not supported then apply to every 710 already in a directory.

A platform operator can set `lineLimit` on a desk phone with `PATCH /phones/{phoneId}` to give it fewer lines than its model takes.

## Telling a phone that its settings changed

When a directory change gives a phone different lines, the phone's state becomes `updating`. Call control asks the API server which phones to tell, with `POST /api/agent-db/pbx/resync/claim` and its token (`CALLCTL_SHARED_TOKEN`). The API server never calls out to call control, and there is nothing else to set. Call control waits while the phone is in a call, then has the SIP edge send the phone a check-sync NOTIFY. The phone fetches its file again and does not restart.

- Call control holds the request open (`waitSeconds`, 30 at most). A change written by the API process that holds the request is given at once. A change written by another process is given within 2 seconds.
- A phone is given to one caller only, and each time it is given counts as one ask. Nothing is counted while call control does not ask, so a phone loses no asks while call control is down.
- Nothing reports that the phone was told. The API server knows when the phone fetches. Until then the phone is given again after 1, 5, 15 and 60 minutes and 6 hours: six times in all for one version of its settings. After that the daily refresh brings the change. A line is logged at the last ask.
- A phone is never given twice within 10 seconds, however many changes are made.
- `device.resync` on a phone read shows the last ask while the phone is `updating`, and is null once it has fetched: `requestedAt`, `attempts`, and `state`. The state is `taken` (given to call control), then what call control reported: `queued`, `sent`, `held` while the phone is in a call, `no_binding` when no line is registered, `failed`. `no_lines` means the phone has no active line, so it was not given.
- A phone that has never fetched, a wiped phone, and a phone that was given a new settings address are not given.
- A line password reset does not make a phone `updating`, so it does not start an ask. A phone that is already `updating` is given for its newest version as usual. The SIP edge then answers for the request with the new password, which a phone that still holds the old one may refuse.
- Each API process holds at most 8 such requests open. One more is answered at once.
- Needs the schema 80 database upgrade (`tools/agent-admin.js upgrade-db`). Until then the route answers 503 `phone_resync_not_ready`.

The call control and SIP edge sides of this are not built yet.

## States and failures

`device.state` on a phone read:

| State | Meaning |
|---|---|
| `waiting` | The phone has an address and has not fetched yet |
| `fetched` | The phone holds the current settings |
| `updating` | The settings changed and the phone has not fetched them yet |
| `wiped` | The phone's address and line accounts are switched off |

The certificate that fetched first stays the phone's certificate through a new address, a wipe and a removal. No route clears it yet.

`device.failure` is `wrong_device` when a different phone asked for the settings, and `model_not_supported` when the phone's model is not supported. `wrong_device` stays until the phone is provisioned again.

## Wipe

`POST /phones/{phoneId}/wipe` stops the phone's address and gives each of its line accounts a new secret that nobody holds, so what the phone has stored stops working. The phone stays in the list. `POST /phones/{phoneId}/provision` brings it back with a new address.

`DELETE /phones/{phoneId}` wipes the phone first.

The platform does not yet tell a registered phone to reset itself.

## Running the service

```shell
yarn provisioning
```

It needs the same `POSTGRES_*` settings and `CREDENTIALS_KEY` as the API server, and the database upgrade (`tools/agent-admin.js upgrade-db`, schema 76). It refuses to start when its settings are not safe.

| Variable | Use |
|---|---|
| `PROV_PUBLIC_URL` | The https address phones fetch from. Set it on the API server too |
| `PROV_PORT` | Listen port. Default 4010 |
| `PROV_SNOM_CA_FILE` | PEM file with Snom's root and intermediate CA certificates |
| `PROV_SNOM_CA_FINGERPRINTS` | SHA-256 fingerprints of the roots to trust. Unset means the root of Snom's SHA-256 CA |
| `PROV_FETCH_LOG_DAYS` | Days a fetch log row is kept. Default 90 |
| `PROV_TLS_CERT_FILE`, `PROV_TLS_KEY_FILE` | The service ends TLS itself and asks the phone for its certificate |
| `PROV_CLIENT_CERT_HEADER`, `PROV_TRUSTED_PROXIES` | A proxy ends TLS and passes the phone's certificate in this header |

Set one of the last two rows, not both.

The host name needs a certificate from a public CA that the phones trust.

### Behind a proxy

The proxy must ask the phone for a client certificate without checking it, pass it on in the header as URL-encoded PEM, and remove any copy of that header a client sends. With ingress-nginx:

```yaml
nginx.ingress.kubernetes.io/auth-tls-secret: "<namespace>/<secret with ca.crt>"
nginx.ingress.kubernetes.io/auth-tls-verify-client: "optional_no_ca"
nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: "true"
```

and `PROV_CLIENT_CERT_HEADER=ssl-client-cert`. The service reads the header only on connections from `PROV_TRUSTED_PROXIES`, and checks the certificate chain itself. Make sure nothing but the proxy can reach the service's port.

Also:

- The proxy must pass the client's address in `X-Forwarded-For`, as the last entry. The limit and the fetch log use it. Without it every phone counts as one address.
- The proxy must replace the certificate header, not add to it. A header with more than one certificate is ignored.
- Give `PROV_TRUSTED_PROXIES` the proxy's own addresses. Do not give it a range that other workloads share. On Kubernetes, add a NetworkPolicy so that only the proxy reaches the service.
- The proxy's access log will hold each phone's settings address, secret part included. Treat that log as you treat the address.

This example has not been run by us against a real ingress.
