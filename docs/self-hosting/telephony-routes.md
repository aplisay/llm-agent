---
title: Telephony routes
description: The open ways to connect a self-hosted instance to the phone network, and what each needs.
audience: operator
status: draft
---

# Telephony routes

A browser call needs nothing on this page. Read it when you want an agent to
answer or place real phone calls.

This page is an overview. It says which routes exist, what each needs and
where its limits are. Step-by-step guides for each route will follow. Only the
browser path is covered by the automated smoke test today, so expect to read
logs on your first phone call.

## What Aplisay runs that is not in this repo

Aplisay's hosted service reaches the phone network through a carrier edge: a
session border controller, carrier interconnects, SIP registrations to
customer phone systems and number ranges. That edge is not open source.

You do not need it. A self-hosted instance connects to a SIP trunk that you
buy from any provider, by one of the three routes below. What you take on is
the work the edge does: the trunk contract, the numbers, the firewall rules
and fraud controls.

If you want Aplisay to run that part, [contact Aplisay](https://aplisay.com/contact).

## The three routes

| Route | Runtime | You run | Fits |
|---|---|---|---|
| LiveKit SIP | `livekit` | LiveKit server, LiveKit SIP and Redis (the `sip-livekit` profile in `compose.yaml`) | You already use the LiveKit runtime. The shortest path from the local stack |
| `sipbridge` | `pipecat` | The Pipecat worker and the `sipbridge` gateway from this repo | You want a small SIP gateway you can read and change, with no LiveKit server in the call path |
| Jambonz | `jambonz`, `ultravox` | The Jambonz worker from this repo, and a Jambonz cluster | You already operate Jambonz |

All three need the same things from the network:

- a public IP address on the host that runs the SIP gateway,
- host networking for the gateway container,
- the SIP port and a wide UDP range for audio open to your trunk provider
  (5060 and 10000 to 20000 by default),
- a SIP trunk from a provider, with your numbers pointed at that IP address.

That rules out platforms that only route HTTP, such as Cloud Run. Use a
virtual machine, or a Kubernetes node pool with public addresses.

## Numbers are records in the API

On every route the API server holds the list of numbers. The steps are the
same:

1. Create a **trunk** record: `POST /api/trunks`. It names the route
   (`handler` is `livekit`, `pipecat` or `jambonz`). This needs the first
   user, which has the `superAdmin` role.
2. Create a **phone endpoint** for each number on that trunk:
   `POST /api/phone-endpoints`.
3. Point a number at an agent: `POST /api/agents/{agentId}/listen` with the
   number. The agent's runtime must match the number's route.

[../phone-endpoints-api.md](../phone-endpoints-api.md) describes the records.

When a call arrives, the worker reads the called number from the SIP request,
asks the API which agent listens on it, and starts that agent. A call to a
number with no listener is rejected.

## Route 1: LiveKit SIP

1. Start the stack with the `sip-livekit` profile. `compose.yaml` lists the
   settings it needs: `LIVEKIT_REDIS_ADDRESS`, `LIVEKIT_NODE_IP` set to the
   public IP address, and `APLISAY_BIND=0.0.0.0`.
2. Create the trunk and number records in the API, as above.
3. Run the LiveKit worker's `setup` command. It reads the `livekit` numbers
   from the API and creates three things in LiveKit: an inbound trunk that
   holds those numbers, an outbound trunk, and a dispatch rule that sends each
   call to the worker. [`agents/livekit/README.md`](../../agents/livekit/README.md)
   has the command.
4. Point your provider's trunk at the host, port 5060.

For outbound calls and transfers, set these in the worker's environment before
you run `setup`:

| Variable | Meaning |
|---|---|
| `LIVEKIT_SIP_OUTBOUND` | Your trunk provider's SIP address |
| `LIVEKIT_SIP_USERNAME`, `LIVEKIT_SIP_PASSWORD` | Its credentials |

Things to know:

- Run `setup` again each time you add a number. It does not run at worker
  start.
- The inbound trunk that `setup` creates accepts calls from any address. Limit
  port 5060 to your provider's addresses with a firewall.
- The outbound trunk uses SIP over TCP.

## Route 2: sipbridge

`sipbridge` is a SIP gateway written in Go, in `agents/pipecat/sipbridge`. It
accepts a SIP call, opens a WebSocket to the Pipecat worker and carries the
audio. It can take calls straight from a provider's trunk and place calls to
one.

It is not in the root `compose.yaml` yet. Today it runs from the Pipecat
directory:

```shell
cd agents/pipecat
cp env-example .env     # then edit, see below
docker compose --profile sipbridge up --build
```

Set at least these in `agents/pipecat/.env`:

| Variable | Meaning |
|---|---|
| `SIP_GATEWAY=sipbridge` | The worker defaults to another gateway |
| `EXT_IP_ADDRESS` | The host's public IP address, for SIP and audio |
| `SERVICE_BASE_URI`, `SHARED_API_TOKEN` | How the worker reaches the API server |
| `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET` | Shared with the API server |
| `PIPECAT_SIP_OUTBOUND` | Your trunk provider's SIP address, for outbound calls and transfers |
| `PIPECAT_SIP_USERNAME`, `PIPECAT_SIP_PASSWORD` | Its credentials. Leave empty for a trunk that authenticates by IP address |
| `PIPECAT_SIP_FROM_DOMAIN` | The domain in the From header, if your provider needs one |

The API server needs `PIPECAT_WORKER_URL`, `PIPECAT_DISPATCH_TOKEN`,
`PIPECAT_JOIN_SECRET` and `PIPECAT_PUBLIC_URL` to enable the `pipecat`
runtime. [configuration.md](configuration.md) lists the `SIPBRIDGE_*`
variables for ports, TLS and SRTP.

Things to know:

- Known gap: `agents/pipecat/docker-compose.yml` passes a fixed list of
  variables to the worker. `PIPECAT_SIP_OUTBOUND` and some provider keys (for
  example `XAI_API_KEY`) are not in that list. Until that is fixed, add the
  ones you need under `pipecat-worker`, `environment` in that file. Without
  `PIPECAT_SIP_OUTBOUND` the worker cannot place outbound calls or transfers.
- `sipbridge` accepts SIP from any address. Limit its SIP port to your
  provider's addresses with a firewall.
- It needs Linux host networking. Docker Desktop changes the source address
  of UDP packets, so use a Linux host for real calls.
- Calls carry extra `X-Aplisay-*` SIP headers. Most providers ignore them.
- The comments in `env-example` are written for Aplisay's own edge. Where they
  say "SBC", read "your trunk provider".

[../sipbridge-integration.md](../sipbridge-integration.md) describes the
gateway in depth.

## Route 3: Jambonz

[Jambonz](https://jambonz.org) is an open-source telephony platform. Aplisay
uses it as a SIP front end for pipeline models and for Ultravox.

1. Connect your SIP trunk to Jambonz as a carrier.
2. Set `JAMBONZ_SERVER` and `JAMBONZ_API_KEY` for the API server and the
   Jambonz worker, and `JAMBONZ_AGENT_NAME` to the public host name of the
   worker.
3. Run the worker in `agents/jambonz`. It connects to the database directly,
   so it needs the same `POSTGRES_*` settings as the API server.
4. Create the trunk and number records in the API, with `handler` set to
   `jambonz`.

At start the worker copies the `jambonz` numbers from the API to Jambonz and
points them at itself. Speech-to-text and text-to-speech credentials for this
route are set in Jambonz.

## Before real traffic

Phone access can cost money quickly if it is abused. Work through
[production-checklist.md](production-checklist.md), and set spending and
destination limits with your trunk provider before you publish a number.
