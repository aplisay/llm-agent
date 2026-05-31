# Pipecat esl-poller

Extension of the [aplisay-b2bua esl-poller](https://github.com/aplisay/aplisay-b2bua/tree/main/esl-poller).
Adds an HTTP call-control API (`/calls/originate`, `/calls/:uuid/transfer`,
`/calls/:uuid/hangup`) and a channel-event webhook on top of the existing ESL
client. The original gateway-state reconciliation is preserved behind
`GATEWAY_POLL_ENABLED=true` so the same binary still works inside aplisay-b2bua.

This service owns the ESL TCP connection to FreeSWITCH; the Python Pipecat
worker is an HTTP client. Keeping ESL on the TypeScript side means we reuse the
mature `esl-lite` library and the existing parsing/reconciliation logic from
aplisay-b2bua, while the worker stays language-agnostic above the call-control
API.

## Routes

| Method | Path                       | Purpose                          |
| ------ | -------------------------- | -------------------------------- |
| GET    | `/health`                  | Liveness                         |
| POST   | `/calls/originate`         | ESL `originate`                  |
| POST   | `/calls/:uuid/transfer`    | `uuid_deflect` (REFER) or originate+bridge (blind-bridge) |
| POST   | `/calls/:uuid/hangup`      | `uuid_kill`                      |

All routes accept `Authorization: Bearer <CALL_API_TOKEN>` when the token env
var is set; without a token configured, auth is disabled (suitable only for
local-loopback deployments).

## Environment

| Var                       | Default                  | Purpose                                            |
| ------------------------- | ------------------------ | -------------------------------------------------- |
| `ESL_HOST`                | `freeswitch`             | ESL host                                           |
| `ESL_PORT`                | `8021`                   | ESL port                                           |
| `ESL_SECRET`              | `ClueCon`                | ESL password                                       |
| `CALL_API_PORT`           | `4001`                   | HTTP bind port for the call API                    |
| `CALL_API_TOKEN`          | _(unset)_                | Required bearer token for control routes (set this) |
| `CALL_API_ENABLED`        | `true`                   | Toggle the HTTP surface                            |
| `WORKER_EVENT_WEBHOOK`    | _(unset)_                | Where to POST `CHANNEL_*` events                   |
| `WORKER_EVENT_TOKEN`      | `CALL_API_TOKEN`         | Bearer token for the event webhook                 |
| `GATEWAY_POLL_ENABLED`    | `false`                  | Re-enable the aplisay-b2bua gateway state poller   |
| `CONFIG_SERVER_BASE`      | `http://config-server:4000` | Only used when gateway polling is on              |
| `CONFIG_SERVER_TOKEN`     | _(unset)_                | Bearer token for the config server                 |

## Channel events

When `WORKER_EVENT_WEBHOOK` is set, esl-poller subscribes to
`CHANNEL_HANGUP`, `CHANNEL_BRIDGE`, and `CHANNEL_ANSWER` events and POSTs a
flattened JSON payload to the webhook on each:

```json
{
  "event": "CHANNEL_HANGUP",
  "channelUuid": "...",
  "callerId": "+44...",
  "calledId": "+44...",
  "hangupCause": "NORMAL_CLEARING",
  "bridgedTo": null,
  "aplisayTrunk": "...",
  "aplisayCallId": "..."
}
```

## Building and testing

Standard yarn/Node workflow inherited from the aplisay-b2bua project:

```bash
yarn install
yarn build
yarn test
```

The existing test suite (gateway state parsing, reconciliation) is unchanged
and continues to cover those exports.
