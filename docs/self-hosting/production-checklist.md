---
title: Production checklist
description: What to check before a self-hosted instance is reachable from the internet.
audience: operator
status: current
---

# Production checklist

Work through this before the instance is reachable from the internet. An
instance with phone access can place calls that cost money, so treat its keys
like payment credentials.

## Secrets

- [ ] `.env` was made by `scripts/compose-setup.sh`, or every secret in it is a
      long random value you generated. No value is copied from a document or
      an example.
- [ ] `SHARED_API_TOKEN` is at least 24 random characters. It gives full
      access to every route. Only the voice workers need it.
- [ ] `CREDENTIALS_KEY` is set, and you have a copy somewhere safe. Without it
      stored SIP passwords and agent keys are kept in plain text. If you lose
      it, they cannot be read.
- [ ] `BOOTSTRAP_API_KEY` is treated as an administrator password. The user it
      creates has the `superAdmin` role.
- [ ] `APLISAY_STUB_MODEL` is unset.
- [ ] `DB_FORCE_SYNC` is unset.
- [ ] `GET /api/health` shows no warnings you have not read.

## Network

- [ ] The API is served over HTTPS. The `edge` profile in `compose.yaml` runs
      Caddy for this: set `APLISAY_DOMAIN`, `LIVEKIT_DOMAIN` and
      `LIVEKIT_PUBLIC_URL=wss://<LIVEKIT_DOMAIN>`.
- [ ] Only the ports you need are open: 80 and 443 for the edge, 7881/tcp and
      7882/udp for LiveKit media, and the SIP and RTP ports if you take phone
      calls.
- [ ] PostgreSQL is not published. The compose stack does not publish it.
- [ ] The test page on port 8080 is not reachable from outside. It is for
      development only. The `edge` profile does not expose it.
- [ ] Port 4000 is not published directly. Leave `APLISAY_BIND` at its default
      when the edge fronts the API.

A browser app on your own domain cannot call the API directly today: the
allowed cross-origin list is fixed in `index.mjs`. Serve the app and the API
from one origin through your reverse proxy, as the test page does.

## Users and keys

- [ ] Each person or system has its own API key, made with
      `node tools/agent-admin.js add-authkey`. Do not share the first key.
- [ ] You know how to remove a key: `node tools/agent-admin.js delete-authkey`.
- [ ] If people sign in through a front end, user sign-in is configured
      (`environment-example.polite-ai` has the settings). An instance used
      only through API keys needs none of it.

## Telephony

- [ ] Your SIP trunk accepts calls only from your addresses, and your gateway
      accepts SIP only from your trunk provider's addresses.
- [ ] You have set call limits with your trunk provider: destinations, spend
      and concurrent calls.
- [ ] You have read [../outbound-call-authorisation.md](../outbound-call-authorisation.md)
      and [../agent-concurrency-limits.md](../agent-concurrency-limits.md).
- [ ] Transfers go only to numbers you expect. See the anti-fraud rules in
      [../call-transfers.md](../call-transfers.md).

## Data

- [ ] The database is backed up, and you have restored a backup once.
- [ ] `RECORDING_STORAGE_PATH` points at storage you control and back up. The
      compose default is a local volume.
- [ ] You know your retention needs for transcripts and recordings.

## Operation

- [ ] Something watches `GET /api/health` and tells you when it stops
      returning 200.
- [ ] Logs are kept. The services write JSON logs to standard output.
- [ ] You have a plan for upgrades: [upgrading.md](upgrading.md).
- [ ] The API server and the workers run the same version.

## When this is too much

Running a carrier edge, number ranges and a 24-hour service is real work. If
you would rather not, Aplisay runs this platform for service providers.
[Contact Aplisay](https://aplisay.com/contact).
