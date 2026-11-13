---
title: Self-hosting
description: How to run the platform yourself, what the repo contains and what it does not.
audience: operator
status: current
---

# Self-hosting

These pages are for someone who runs the platform themselves: on a laptop, on
one server, or as part of a larger deployment.

## Pages

| Page | Read it when |
|---|---|
| [quickstart-local.md](quickstart-local.md) | You want the whole stack running on one machine with Docker Compose |
| [choose-a-runtime.md](choose-a-runtime.md) | You need to decide which voice runtime to enable |
| [configuration.md](configuration.md) | You need the meaning of an environment variable |
| [telephony-routes.md](telephony-routes.md) | You want phone calls, not only browser calls |
| [production-checklist.md](production-checklist.md) | The instance will be reachable from the internet |
| [deploy-aws-ec2.md](deploy-aws-ec2.md) | You want it on AWS: one EC2 instance, from a new account to a working API |
| [byo-trunk-sipbridge.md](byo-trunk-sipbridge.md) | You have a SIP trunk from a provider and want calls on the Pipecat runtime |
| [user-accounts.md](user-accounts.md) | Several people need their own sign-in |
| [upgrading.md](upgrading.md) | You are moving to a newer version |
| [troubleshooting.md](troubleshooting.md) | Something does not start or does not answer |

[../running.md](../running.md) covers running from source without containers.

## How to get access

There are two ways to use the platform.

- **Run it yourself.** Everything in these pages. You create your own first API
  key, so you need no account with Aplisay.
- **Have Aplisay run it.** Hosted access is by commercial agreement.
  [Contact Aplisay](https://aplisay.com/contact). There are no trial keys for
  the hosted API.

## What is in this repo and what is not

| Part | In this repo | Notes |
|---|---|---|
| API server | Yes | REST API, WebSocket feed, database schema, billing and tenancy |
| LiveKit voice worker | Yes | `agents/livekit` |
| Pipecat voice worker | Yes | `agents/pipecat` |
| `sipbridge` SIP gateway for Pipecat | Yes | `agents/pipecat/sipbridge` |
| Jambonz worker | Yes | `agents/jambonz`. You bring the Jambonz cluster |
| Compose stack and test page | Yes | `compose.yaml`, `tools/test-page` |
| LiveKit server, LiveKit SIP | No | Open-source projects from LiveKit. The compose stack pulls their images |
| Model, speech and voice providers | No | You bring your own provider keys |
| Aplisay carrier edge | No | The session border controller, trunk interconnects, SIP registrations at scale and number ranges that Aplisay operates. See [telephony-routes.md](telephony-routes.md) for the open routes to the phone network |
| Web builder and user sign-up front end | No | The API is complete without them |

## Support

Support for self-hosted instances is best effort. Read
[troubleshooting.md](troubleshooting.md) first, then open a GitHub issue with
the output of `GET /api/health`. There is no promised response time.

If you run the platform commercially and want a support agreement, or want
Aplisay to run the carrier edge for you,
[contact Aplisay](https://aplisay.com/contact).
