# Registration trace and probe API

Two additive routes on the Phone Endpoints API make SIP registration diagnosable
from the dashboard instead of from a node shell:

| Route | Purpose |
|---|---|
| `GET /api/phone-endpoints/{id}/trace` | Index of the SIP exchanges captured for this registration — REGISTER ladders, recent call dialogs, keepalive counters |
| `GET /api/phone-endpoints/{id}/trace/{transactionId}` | One of those exchanges, in full |
| `POST /api/phone-endpoints/{id}/probe` | Run a live registration attempt now and report what happens |
| `GET /api/phone-endpoints/{id}/probe/{probeId}/events` | Server-sent events from a running probe |
| `GET /api/phone-endpoints/{id}/probe/{probeId}` | The finished probe report |

Both apply only to `phone-registration` endpoints; a DDI number has no
registration to trace.

## Why these exist

Until now the only observable signal from a registration was the `state` and
`error` columns changing, and those were derived from a status poll on a five
minute reconcile cycle — worst case around 35 minutes between a registration
breaking and anything saying so, with the actual SIP failure never recorded. A
failing onboarding produced "state: failed" and nothing else.

The b2bua that replaces the FreeSWITCH stack (`regclient`, planned in
[aplisay-b2bua `docs/regclient-plan.md`](https://github.com/aplisay/aplisay-b2bua/blob/main/docs/regclient-plan.md))
writes state on the SIP transaction that caused it, and keeps a bounded trace of
every message it sends and receives per registration. These routes expose that.

## Where the data comes from

There is no central trace store. Each registration is claimed by exactly one
b2bua node, recorded in `phone_registrations.b2bua_id` — the same pointer the
originate path follows to route outbound calls — and that node holds the trace
in memory. The API is a proxy:

1. Load the registration; check it belongs to the caller's organisation.
2. Read `b2bua_id`. Empty means no node has ever claimed it: `409`, because
   there is nothing to ask.
3. Fetch from that node over TLS verified against a private CA, presenting a
   bearer token, with a hard timeout and no retries.
4. Stream the answer back, tagged with which node answered and when.

A node that is down therefore produces a prompt `504 {error, node, reason}`
rather than a hung request — and names the node, so an operator knows which
instance to look at.

## Nodes that have no trace API

Not every b2bua node serves these routes. The FreeSWITCH stack has no HTTP
surface at all, and during the migration both stacks run side by side against
the same table — so `b2bua_id` may perfectly legitimately point at a node that
cannot answer.

That case returns **`501`**, not `504`:

```json
{
  "code": "trace-api-unavailable",
  "node": "203.0.113.10",
  "message": "The b2bua node holding this registration (203.0.113.10) does not provide the trace and probe API..."
}
```

The distinction is the point. `504` means a node that should have answered
did not — worth investigating. `501` means the registration is held by a node
running the older stack, which is an ordinary state of affairs during a
migration and is fixed by moving the registration, not by retrying.

**It is fast, and it stays fast.** No separate capability endpoint or handshake
is involved, because the request already proves the answer: a FreeSWITCH node
has no HTTP surface, and nothing else can present a certificate signed by the
private CA in our own bundle. So reaching a node at all — even to be refused
with a `401` — establishes that it is regclient.

That verdict is cached per node, so it is paid at most once:

- **First call to an unknown node**: bounded by `REGCLIENT_DISCOVERY_TIMEOUT_MS`
  (750 ms) rather than the full request budget. A closed port refuses in
  milliseconds; only a firewall that drops rather than rejects costs the whole
  750 ms, and only once.
- **Every call after that**: answered from cache with no network call at all —
  microseconds.
- **A timeout is never cached.** Something may be listening and merely busy, and
  marking a slow regclient node as having no API would be a lie that outlived
  the moment. Only connection-level failures — refused, unreachable, TLS —
  settle the question.

Positive verdicts are held for `REGCLIENT_CAPABILITY_TTL_MS` (10 minutes;
a node does not change stack without a redeploy). Negative ones for
`REGCLIENT_UNSUPPORTED_TTL_MS` (1 minute), because migrating a node to regclient
is exactly when somebody will go looking for its traces.

## Two steps, not one

A full trace runs to tens of kilobytes of SIP text — eight REGISTER ladders and
a couple of call dialogs, each message up to 4 KiB. That is the right thing for
a node to hold and the wrong thing to return on every read: a dashboard listing
wants to know *what happened*, not to re-download all of it each time it
renders.

So reading a trace is two steps.

**The index** (`GET …/trace`) lists the exchanges, most recent first, at a
couple of hundred bytes each:

```json
{
  "registrationId": "…", "node": "203.0.113.10",
  "capturedAt": "…", "fetchedAt": "…",
  "transactions": [
    { "id": "reg-8", "kind": "register", "summary": "REGISTER → 403 Forbidden",
      "outcome": "failure", "code": 403, "startedAt": "…", "rttMs": 34,
      "pinned": true, "messages": 4, "bytes": 2870 },
    { "id": "call-2", "kind": "call", "direction": "inbound",
      "summary": "INVITE → 200 OK", "outcome": "completed",
      "callId": "…", "startedAt": "…", "endedAt": "…", "messages": 8, "bytes": 9012 }
  ],
  "keepalive": { "sent": 412, "ok": 411, "failed": 1, "transitions": [ … ] },
  "evictions": { "registerTransactions": 12, "calls": 3, "truncatedMessages": 0 }
}
```

`pinned` marks the entries kept regardless of rotation — the most recent
successful and most recent failed REGISTER — so a retry storm cannot evict the
last known-good exchange you want to diff against. `evictions` says what has
been discarded, so a gap in the history is never silent.

**The detail** (`GET …/trace/{transactionId}`) returns one of those entries with
every message, in the representation you ask for.

## Trace formats

`?format=` selects the representation.

On the **detail** route, all three:

- **`json`** (default) — the transcript: each message with its envelope
  (direction, transport, five-tuple, timestamp) and raw text.
- **`decode`** — a flat chronological array of decoded packets: parsed headers
  (order and duplicates preserved, so Via chains and route sets survive), CSeq,
  dialog identifiers and parsed SDP. For building a UI that renders a ladder
  without a SIP parser in the browser.
- **`pcap`** — that exchange as a capture file.

On the **index** route, `json` (the listing) and `pcap`. Asking a listing for
`decode` would be exactly the fat response the split exists to avoid, so it is
refused with a pointer at the right route. `pcap` on the index is deliberate and
covers the **whole** registration: "give me everything for Wireshark" is a real
request, and a capture of one transaction on its own rarely is.

Captures are `application/vnd.tcpdump.pcap` and open in Wireshark or sngrep with
the real five-tuples. TLS legs are exported **decrypted**, which an on-wire
capture can never give you.

The trace is a bounded ring buffer, not a log. It does not survive a node
restart, and entries rotate as new activity arrives — an id you listed a few
minutes ago may since have aged out behind a burst of retries, which the detail
route reports as a 404 saying so.

Digest credentials in `Authorization` and `Proxy-Authorization` are redacted at
this API and cannot be un-redacted through it.

## Probes

A probe performs a real REGISTER and reports it as it happens: transport
connect, challenge, authenticated retry, final response — sub-second to a few
seconds, streamed. `POST` returns `202 {probeId, node}`; stream progress from
`…/probe/{probeId}/events` or read the report from `…/probe/{probeId}` once it
finishes.

The report carries a verdict (`registered`, `bad-credentials`, `unreachable`,
`tls-failure`, `no-route`, …), a one-line diagnosis suitable to show a user, and
the transcript of each branch attempted.

With `{"discover": true}` the node walks a small matrix — transports in the
order tls, tcp, udp, with and without a next-hop proxy, learning the realm from
the first challenge — and returns the minimal `options` patch that worked, e.g.
`{"transport":"tcp","realm":"pbx.local"}`. Adding `{"apply": true}` merges that
patch into the endpoint and restarts its registration.

Note the interaction with `PUT /phone-endpoints/{id}`: an update replaces
`options` wholesale, so a later dashboard save can drop an applied patch. The
patch is re-derivable by re-probing.

Probing a registration that is currently registered is safe: the node reuses the
registration's existing contact, so the probe degrades to a forced refresh and
cannot create a second binding at the registrar or drop the live one.

Only registrations the caller's organisation owns can be probed. There is no
free-form "try these credentials against this registrar" form on this API,
deliberately — that would be a credential-testing oracle.

## Configuration

Both routes answer `503` unless the deployment is configured to reach nodes:

| Variable | Meaning |
|---|---|
| `REGCLIENT_API_TOKEN` | Bearer token presented to nodes; shared through the same secretenv bundle the nodes get. Absent ⇒ routes disabled |
| `REGCLIENT_API_PORT` | Node API port (default 8443) |
| `REGCLIENT_CA_CERT` | Public certificate of the private CA that signs node certificates; PEM or base64 of a PEM |
| `TRACE_PROXY_TIMEOUT_MS` | Hard per-request timeout, default 2000 ms. No retries |
| `REGCLIENT_PROBE_NODES` | Nodes that may run a probe for a registration no node has claimed |
| `REGCLIENT_NODE_ALLOWLIST` | Optional pin: only these node addresses may be contacted |
| `REGCLIENT_ALLOW_PRIVATE_NODES` | Permit node addresses in private ranges (compose, kind). Off by default |
| `REGCLIENT_API_INSECURE` | Development only: skip TLS verification |
| `REGCLIENT_DISCOVERY_TIMEOUT_MS` | 750. Bound on the first request to a node we have never reached, so learning it runs FreeSWITCH is cheap |
| `REGCLIENT_CAPABILITY_TTL_MS` | 600000. How long a node is remembered as serving this API |
| `REGCLIENT_UNSUPPORTED_TTL_MS` | 60000. How long a node is remembered as not serving it — short, so a migration is picked up promptly |

### The node address is untrusted input

`b2bua_id` is normally written by the node that claimed the row, but
`PUT /phone-endpoints/{id}` also permits writing it — that is the
per-registration migration lever, and it means the value is caller-influenced.
Dialling it unchecked would make this facade an SSRF gadget that hands the node
bearer token to whatever host was named.

So the address is validated before any connection: it must be a bare IP literal
or DNS name (no scheme, credentials, path or port smuggling); link-local
(`169.254.0.0/16`, `fe80::/10` — the cloud metadata range) is refused
unconditionally; loopback and private ranges are refused unless
`REGCLIENT_ALLOW_PRIVATE_NODES` says otherwise; and when
`REGCLIENT_NODE_ALLOWLIST` is set nothing outside it is contacted at all.

This sits underneath, not instead of, the network layer: node API ports are
expected to be firewalled to the API's egress addresses in every environment.
