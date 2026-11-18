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

Every refusal is a 404 with an empty body, so an address that names no phone looks the same as a refused one. Every request is written to `device_fetch_logs` with its result.

## What the file holds

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

This example has not been run by us against a real ingress.
