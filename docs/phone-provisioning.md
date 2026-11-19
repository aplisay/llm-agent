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

## What the file holds

A key on the phone's first page that has no line is cleared.

For each line: `user_name`, `user_pname`, `user_hash`, `user_host`, `user_outbound` (TLS), SRTP required, and a `line` key with the line's label. `user_hash` is the digest hash of the line's account. `user_pass` is empty: the file never holds a password, and neither does the database.

The file also locks the phone's settings address, switches its web interface to HTTPS, and sets its admin and web password. That password is made from `CREDENTIALS_KEY` and the phone's id, and is stored nowhere. With `CREDENTIALS_KEY` unset it is random at each fetch.

The file does not pin a firmware version.

## The phone's model

The phone names its model when it fetches. If that differs from the model that was typed, the reported model wins and the phone's lines are worked out again. A model that is not in the catalogue is refused, and the phone shows the failure `model_not_supported`.

A platform operator can set `lineLimit` on a desk phone with `PATCH /phones/{phoneId}` to give it fewer lines than its model takes.

## States and failures

`device.state` on a phone read:

| State | Meaning |
|---|---|
| `waiting` | The phone has an address and has not fetched yet |
| `fetched` | The phone holds the current settings |
| `updating` | The settings changed and the phone has not fetched them yet |
| `wiped` | The phone's address and line accounts are switched off |

The certificate that fetched first stays the phone's certificate through a new address, a wipe and a removal. No route clears it yet.

`device.failure` is `wrong_device` when a different phone asked for the settings, and `model_not_supported` when the phone reported a model the catalogue does not have. `wrong_device` stays until the phone is provisioned again.

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
