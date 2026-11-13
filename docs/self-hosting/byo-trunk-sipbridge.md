---
title: Your own SIP trunk through sipbridge
description: Step by step, how to take and place phone calls on a self-hosted instance with a SIP trunk from a provider, the Pipecat worker and the sipbridge gateway.
audience: operator
status: current
---

# Your own SIP trunk through sipbridge

This guide connects a SIP trunk you buy from a provider to an agent on the
Pipecat runtime. `sipbridge` is the SIP gateway in this repo
(`agents/pipecat/sipbridge`). It takes the call from your provider, opens a
WebSocket to the Pipecat worker and carries the audio.

Inbound calls are verified: on 2026-11-13 a call from a UK carrier's trunk
reached an agent on a new Linux host set up from this guide, with audio in
both directions. Outbound calls are checked as far as the SIP signalling,
with a script in place of the provider, and not yet through a provider's
trunk. Please report what you find.

Read [telephony-routes.md](telephony-routes.md) first if you have not chosen
a route.

## Check that your trunk fits

`sipbridge` is small. It works with a trunk that does all of these:

| Your trunk must | Why |
|---|---|
| Send calls to a fixed public IP address, with no registration | `sipbridge` does not send REGISTER |
| Accept your calls by your IP address, or by a user name and password on the INVITE | Those are the two ways it can authenticate |
| Speak SIP over UDP on port 5060, or SIP over TLS | There is no plain TCP listener |
| Use G.711 audio (PCMU or PCMA) | No other codec is accepted |
| Send audio from the address in its own SDP | There is no NAT latching, so a PBX behind NAT gets no audio |
| Put the called number in the `To` header | That is where the number is read from |

It holds one set of trunk credentials, so it serves one provider account.
Hold and re-INVITE are refused.

If your trunk needs registration, use the LiveKit SIP route or a PBX in
front.

## What you need

- A Linux host with a public IP address. Host networking is required, and
  Docker Desktop does not carry the audio correctly.
- The API server running and reachable from that host. The
  [local quickstart](quickstart-local.md) on the same host is enough.
- A model provider key for a `pipecat:` model. `pipecat:openai/gpt-realtime`
  needs only `OPENAI_API_KEY`.
- From your provider: the address to send calls to, the credentials if it
  uses them, the addresses its calls come from, and at least one number.

## 1. Tell the API server about the worker

Add these to the API server's `.env` (the repo root, for the compose bundle):

```shell
PIPECAT_WORKER_URL=http://host.docker.internal:8082
PIPECAT_PUBLIC_URL=http://<host public address>:8082
PIPECAT_DISPATCH_TOKEN=<random, openssl rand -hex 24>
PIPECAT_JOIN_SECRET=<random, openssl rand -hex 24>
```

`host.docker.internal` is the host as the API container sees it. If the API
server does not run in the compose bundle, use an address where it can reach
the worker's port 8082.

Restart the API server and check the runtime is on:

```shell
docker compose up -d
curl -s http://localhost:4000/api/health
```

Find `pipecat` under `runtimes`. It should say `"enabled": true`.

## 2. Configure the worker and sipbridge

```shell
cd agents/pipecat
cp env-example .env
```

Set these in `agents/pipecat/.env`:

| Variable | Value |
|---|---|
| `SIP_GATEWAY` | `sipbridge`. The default is another gateway |
| `EXT_IP_ADDRESS` | The host's public IP address. It goes in the SIP and audio addresses |
| `SERVICE_BASE_URI` | The API server without `/api`. With the compose bundle on the same host: `http://127.0.0.1:4000` |
| `SHARED_API_TOKEN` | The same value as in the API server's `.env` |
| `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET` | The same values as in step 1 |
| `OPENAI_API_KEY` | Or the key for the model you use |
| `PIPECAT_SIP_OUTBOUND` | Where to send outbound calls: `host[:port][;transport=tls\|tcp\|udp]`, from your provider |
| `PIPECAT_SIP_FROM_DOMAIN` | The domain for the `From` header on outbound calls. Without it no caller ID is sent. Your provider says what it expects; its own domain or your public IP address are common |
| `PIPECAT_SIP_USERNAME`, `PIPECAT_SIP_PASSWORD` | Only if your provider asks for a user name and password. Leave them out for a trunk that knows you by IP address |

Every variable in this file reaches both containers. The other
`SIPBRIDGE_*` settings (TLS certificate, SRTP, RTP timeout, SIP trace) are in
[configuration.md](configuration.md).

Start them:

```shell
docker compose --profile sipbridge up --build -d
docker compose --profile sipbridge logs -f
```

The first build takes several minutes.

## 3. Firewall

This step is not optional on a public host. Allow only what is listed.

| Port | Open to | What |
|---|---|---|
| 5060/udp | Your provider's addresses only | SIP. `sipbridge` answers any address that reaches it |
| 5061/tcp | Your provider's addresses only, or nobody | SIP over TLS. It listens by default |
| 10000-20000/udp | Your provider's media addresses, or everyone | Audio. Providers often send audio from other addresses than their signalling. If you list addresses, use the media ranges the provider publishes |
| 8082/tcp | The API server, and browsers only if you use Pipecat WebRTC | The worker |
| 8090/tcp | Nobody | The `sipbridge` control API. It listens on loopback by default. Keep it there |

Set a spend limit and a destination list with your provider as well. See
[production-checklist.md](production-checklist.md).

## 4. Create the trunk, the number and the listener

Use the first API key, which belongs to a super admin. Set these once:

```shell
export APLISAY_API=http://localhost:4000/api
export KEY=<the first API key>
```

Find your organisation id:

```shell
curl -s "$APLISAY_API/me" -H "Authorization: Bearer $KEY"
```

Create the trunk record. `handler` must be `pipecat`. The trunk must list
your organisation, or the next step answers 400:

```shell
curl -s "$APLISAY_API/trunks" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"my-carrier","name":"My carrier","handler":"pipecat","outbound":true,"organisationIds":["<organisation id>"]}'
```

Add a number. Write it in full international form:

```shell
curl -s "$APLISAY_API/phone-endpoints" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"type":"e164-ddi","number":"+442079460810","trunkId":"my-carrier","outbound":true}'
```

Create an agent on a `pipecat:` model and point the number at it:

```shell
curl -s "$APLISAY_API/agents" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Front desk","modelName":"pipecat:openai/gpt-realtime","prompt":"You answer the phone for a small office. Be brief."}'

curl -s "$APLISAY_API/agents/<agent id>/listen" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"number":"+442079460810"}'
```

Keep the `id` in the last answer. It is the listener id, used for outbound
calls.

## 5. Point your provider at the host

In your provider's portal, send calls for your number to
`sip:<number>@<EXT_IP_ADDRESS>:5060` over UDP.

**The number format matters.** The worker takes the user part of the `To`
header, removes a leading `+`, and looks for exactly that number. A number
stored as `+442079460810` matches a `To` of `+442079460810` or
`442079460810`. It does not match `02079460810`. Ask your provider to send
full international numbers. If it cannot, store the number the way it sends
it.

Call the number. The agent should answer.

## 6. Place an outbound call

```shell
curl -s -X POST "$APLISAY_API/listener/<listener id>/originate" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"calledId":"+441134960001","callerId":"+442079460810"}'
```

- `callerId` must be one of your numbers, created with `"outbound": true` on
  a trunk with `"outbound": true`.
- The call goes to `sip:<calledId>@<PIPECAT_SIP_OUTBOUND>`. The called number
  is sent as you wrote it.
- The `From` header is `sip:<callerId without +>@<PIPECAT_SIP_FROM_DOMAIN>`.
- **Destinations are limited to UK geographic and mobile numbers by
  default.** Another destination answers 400 with `default_filter`. To allow
  others, set `options.outboundCallFilter` on the agent to a pattern that
  matches the numbers you allow. See
  [../outbound-call-authorisation.md](../outbound-call-authorisation.md).
- The INVITE carries two extra headers, `X-Aplisay-Trunk` and
  `X-Aplisay-Call-Id`. Most providers ignore them.

## When it does not work

| What you see | Cause |
|---|---|
| The caller hears a failure at once; the worker log says `Phone endpoint not found` | The number in the `To` header is not stored in that exact form. See step 5 |
| SIP 500; the worker log says `Missing API key` | The model's provider key is not in `agents/pipecat/.env` |
| SIP 503 | The worker cannot reach the API server. Check `SERVICE_BASE_URI` and `SHARED_API_TOKEN` |
| No SIP reaches the host | The firewall, or the provider is sending to another address or over TCP |
| The call connects with no audio, or audio one way | The audio port range is closed, `EXT_IP_ADDRESS` is not the public address, or the far end is behind NAT |
| `listen` answers "routes to ... but this agent uses pipecat" | The trunk's `handler` is not `pipecat`, or the agent's model is not a `pipecat:` model |
| `phone-endpoints` answers 400 | The trunk does not list your organisation, or the trunk has no `"outbound": true` and the number asks for it |
| `originate` says "has no route for a trunk-origin call" | `PIPECAT_SIP_OUTBOUND` is not set |
| `originate` answers 400 `default_filter` | The destination is outside the default UK filter. See step 6 |
| Outbound calls show no caller ID | `PIPECAT_SIP_FROM_DOMAIN` is not set |

To see every SIP message, set `SIPBRIDGE_SIP_TRACE=true` in
`agents/pipecat/.env` and restart `sipbridge`.

## What was checked

With a real trunk, on 2026-11-13, on one EC2 instance set up from this guide
([deploy-aws-ec2.md](deploy-aws-ec2.md)):

- An inbound call from a UK carrier was answered by a
  `pipecat:openai/gpt-realtime` agent, with audio in both directions.
- The carrier sent the number without `+` in the request line and with `+`
  in the `To` header. The stored number matched.
- The carrier's audio came from a different address range than its
  signalling.
- It offered six codecs and the call used G.711 (PCMU), with no SRTP.
- The caller's hangup ended the call cleanly.

On a test host, with a script standing in for the provider:

- An inbound INVITE for an unknown number, or a number in national form, is
  answered 404.
- The called number is taken from the `To` header, not the request line.
- An outbound call reaches the address in `PIPECAT_SIP_OUTBOUND` with the
  `From` header and the extra headers described above.
- A destination outside the default filter is refused.

Not checked: an outbound call through a provider, a trunk with a user name
and password, SIP over TLS, SRTP, DTMF and transfers.
