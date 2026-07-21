# Inbound SIP headers: `aplisay.sipHeaders`

This document describes how custom **`X-` headers on an inbound SIP INVITE** are
surfaced to a voice agent as call metadata under `aplisay.sipHeaders`, so agent
logic (and tools) can read per-call context the carrier or your SBC put on the
call. It is written for API users; for the runtime internals see
[`livekit-agent-architecture.md`](./livekit-agent-architecture.md),
[`sipbridge-integration.md`](./sipbridge-integration.md) and
[`voiceblender-integration.md`](./voiceblender-integration.md).

## Overview

When a telephone call arrives over SIP, the INVITE can carry arbitrary custom
headers — by SIP convention named `X-Vendor-Something`. Upstream equipment (your SBC, a
B2BUA, or the carrier trunk) routinely uses these to attach out-of-band context
to a call: a customer or account identifier, a campaign or queue tag, an
originating site, a language hint, and so on.

On the qualifying inbound paths (see [Where it works](#where-it-works)), the
runtime collects **every `X-` header from the INVITE** and exposes them on the
call's metadata as:

```jsonc
// call.metadata.aplisay
{
  "callerId": "441632960001",
  "calledId": "441632960002",
  "model": "…",
  "sipHeaders": {
    "x-customer-id": "AC-4021",
    "x-campaign": "spring-sale",
    "x-aplisay-trunk": "…",   // the routing headers are X- headers too, so they appear here
    "x-lk-realip": "…"
  }
}
```

Key points:

- **Keys are lowercased** and kept in their `x-header-name` form. `X-Customer-ID`
  on the wire becomes the key `x-customer-id`. Values are passed through
  verbatim as strings.
- **All** `X-` headers are included — including the Aplisay/LiveKit routing
  headers (`x-aplisay-trunk`, `x-aplisay-phoneregistration`, `x-aplisay-call-id`,
  `x-lk-realip`, `x-lk-transport`). They are genuine INVITE `X-` headers; the
  runtime does not hide them, so you **MUST** be selective about which headers you allow
  the LLM or other tools calls to see via metadata access mechanisms. 
- `sipHeaders` is present **only when the INVITE carried at least one `X-`
  header**. On calls with none (and on the transports/sessions that don't carry
  it — see below) the key is simply absent, so a lookup of
  `aplisay.sipHeaders.x-anything` resolves to "not present" rather than erroring.

### Where it works

`aplisay.sipHeaders` is populated for genuine **inbound SIP** calls on the
transports that carry the raw INVITE headers:

| Runtime / ingress | `aplisay.sipHeaders` |
|---|---|
| `livekit:` — inbound SIP (native LiveKit SIP) | ✅ all inbound SIP calls |
| `pipecat:` — **sipbridge** gateway | ✅ |
| `pipecat:` — **voiceblender** gateway | ✅ |
| `pipecat:` — Daily gateway | ❌ (Daily doesn't surface arbitrary inbound headers) |
| `pipecat:` — FreeSWITCH gateway | ❌ (carries only specific channel variables) |
| Outbound calls (either runtime) | ❌ (there is no inbound INVITE to us) |
| WebRTC / browser sessions | ❌ (no SIP INVITE) |
| `jambonz:`, `ultravox:`, `text:` | ❌ |

On Pipecat the active gateway is chosen at worker startup via `SIP_GATEWAY`; only
**sipbridge** and **voiceblender** forward the full inbound header set. On
LiveKit there is a single native SIP path (fronted by the SBC that stamps the
headers), so every inbound SIP call qualifies.

---

## Using the headers

The values live on `call.metadata` under `aplisay.sipHeaders`, so any tool
parameter sourced from metadata can read one with an arbitrary-depth dot path —
the same `source: "metadata"` mechanism used for `aplisay.callerId` and the
[chained-tool `toolsCalls.*` values](./tool-call-chaining-metadata-priming.md).

For example, to hand a REST lookup the caller's account id straight from the
INVITE (rather than asking the LLM to repeat it back):

```jsonc
{
  "name": "lookup_account",
  "implementation": "rest",
  "method": "get",
  "url": "https://crm.example.com/accounts/{accountId}",
  "input_schema": {
    "properties": {
      "accountId": {
        "type": "string",
        "in": "path",
        "source": "metadata",
        "from": "aplisay.sipHeaders.x-customer-id",
        "required": true
      }
    }
  }
}
```

Because the parameter is resolved server-side from metadata, the LLM cannot
invent or override it — see
[Tool call chaining via metadata priming](./tool-call-chaining-metadata-priming.md)
for the integrity model and the `redact` option.

> **Header names with dots.** Metadata paths split on `.`, and the segment
> after `sipHeaders.` is the header name itself (e.g. `x-customer-id`). Standard
> `X-` header names contain hyphens, not dots, so they address cleanly; a header
> whose name contained a `.` could not be reached by a dot path.

### Trust boundary

`sipHeaders` values are **inbound data from the caller / carrier**, not something
your configuration asserts. Metadata priming guarantees *integrity* against the
LLM (the model can't change a value resolved from metadata), but it does **not**
make the value trustworthy: whoever originated the call influenced it. Treat a
header like `x-customer-id` as a *claim* to be validated (look it up, check it
against the verified `callerId`, etc.), exactly as you would any caller-supplied
input — especially before using it for authorization or routing decisions.

---

## How it works under the hood

The headers reach the same `metadata.aplisay.sipHeaders` shape by different
routes per runtime:

- **LiveKit.** The inbound SIP trunk is created with
  `includeHeaders = SIP_X_HEADERS` (see `lib/initialise.ts`), which maps every
  `X-` INVITE header onto a `sip.h.x-*` **participant attribute** (the header
  name lowercased). The worker harvests those attributes when it sets up the
  inbound call and stamps them onto the call's `aplisay` metadata. (For
  resilience the harvester also folds in any camelCased `sipHX*` attribute keys
  as a best-effort fallback, preferring the authoritative dotted form.)

- **Pipecat / sipbridge.** The bundled Go bridge parses the INVITE and forwards
  the SIP-derived headers on the **WebSocket opening handshake** to the worker.
  Alongside the fixed routing contract (`X-Aplisay-*`, `X-Lk-*`) it now forwards
  **every other `X-` header verbatim**; the worker's
  `_sipbridge_resolve_agent_from_headers` collects all `x-*` handshake headers —
  excluding sipbridge's own `X-Sipbridge-*` transport metadata — into
  `sipHeaders`. See [`sipbridge-integration.md`](./sipbridge-integration.md).

- **Pipecat / voiceblender.** Voiceblender delivers the inbound INVITE's `X-`
  headers in the `sip_headers` field of its `leg.ringing` VSI event (its SIP
  ingress extracts every `X-*` INVITE header); the gateway collects them into
  `sipHeaders` when it builds the inbound call context. See
  [`voiceblender-integration.md`](./voiceblender-integration.md).

All three lowercase the header names and keep only `x-*` entries, so the
`aplisay.sipHeaders` shape is identical regardless of which ingress a call
arrived on.

## See also

- [`tool-call-chaining-metadata-priming.md`](./tool-call-chaining-metadata-priming.md)
  — the `source: "metadata"` mechanism, dot-path references, and the `redact`
  confidentiality option.
- [`sipbridge-integration.md`](./sipbridge-integration.md) /
  [`voiceblender-integration.md`](./voiceblender-integration.md) — the Pipecat
  SIP gateways that carry the inbound headers.
- [`livekit-agent-architecture.md`](./livekit-agent-architecture.md) — the
  LiveKit runtime and its SIP header/attribute handling.
