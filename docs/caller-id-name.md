# Caller display name: `aplisay.callerIdName`

This document describes how the **display-name on an inbound SIP INVITE's
`From` header** — the caller's freeform name as presented on the wire — is
surfaced to a voice agent as call metadata under `aplisay.callerIdName`,
alongside the caller's number in `aplisay.callerId`. It is written for API
users; for the runtime internals see
[`livekit-agent-architecture.md`](./livekit-agent-architecture.md),
[`sipbridge-integration.md`](./sipbridge-integration.md) and
[`voiceblender-integration.md`](./voiceblender-integration.md). The companion
mechanism for custom `X-` headers on the same INVITE is
[`sip-headers.md`](./sip-headers.md).

## Overview

A SIP `From` header carries the caller's address and, optionally, a
*display-name*: the freeform text a PBX, softphone or carrier puts in front of
the URI (RFC 3261 §20.20). All three of these are valid:

```
From: "Alice Smith" <sip:+441632960001@pbx.example.com>;tag=1928301774
From: Alice Smith <sip:+441632960001@pbx.example.com>;tag=1928301774
From: <sip:+441632960001@pbx.example.com>;tag=1928301774      <- no display-name
```

On the qualifying inbound paths (see [Where it works](#where-it-works)) the
runtime reads that display-name **as it arrived at the worker's ingress** and
exposes it on the call's metadata as:

```jsonc
// call.metadata.aplisay
{
  "callerId": "441632960001",
  "callerIdName": "Alice Smith",
  "calledId": "441632960002",
  "model": "…"
}
```

Key points:

- **The value is the display-name only**, unquoted and with backslash escapes
  resolved (`"Smith, \"Ali\""` becomes `Smith, "Ali"`), control characters
  removed and whitespace collapsed. It is not the number, not the URI and not
  a looked-up CNAM record: it is whatever the sending equipment chose to put
  there.
- `callerIdName` is present **only when the `From` header carried a
  display-name**. A `From` in bare address form (`<sip:…>` or `sip:…`), or one
  whose display-name is empty or whitespace, leaves the key absent, so a
  lookup of `aplisay.callerIdName` resolves to "not present" rather than `""`.
  Outbound calls, WebRTC sessions and the transports below that don't carry
  the header never have it.
- Once stamped it travels with the call like the rest of the `aplisay` block:
  an agent-to-agent handover (`transfer_agent`) and a human hand-back
  take-over call both inherit the original caller's `callerIdName`.

### Where it works

| Runtime / ingress | `aplisay.callerIdName` |
|---|---|
| `livekit:` — inbound SIP (native LiveKit SIP) | ✅ all inbound SIP calls |
| `pipecat:` — **sipbridge** gateway | ✅ |
| `pipecat:` — **voiceblender** gateway | ⚠️ the gateway reads a `from_display_name` field on the `leg.ringing` event, but voiceblender does not emit one yet (its `from` is the bare user part) — absent until it does |
| `pipecat:` — Daily gateway | ❌ |
| `pipecat:` — FreeSWITCH gateway | ❌ (the start event carries only the configured channel variables) |
| Outbound calls (either runtime) | ❌ (there is no inbound INVITE to us) |
| WebRTC / browser sessions | ❌ (no SIP INVITE) |
| `jambonz:`, `ultravox:`, `text:` | ❌ |

---

## Using the name

`callerIdName` lives on `call.metadata` under `aplisay`, so it is addressable
everywhere the other `aplisay.*` values are:

- **In the prompt**, via [`promptMetadata`](./prompt-metadata.md):

  ```jsonc
  { "description": "The caller's name, as presented by their phone system, is", "from": "aplisay.callerIdName" }
  ```

  An entry whose value is absent is omitted from the prompt, so a prompt that
  states the name stays correct on calls that arrive without one.

- **In tools**, as a `source: "metadata"` parameter with
  `"from": "aplisay.callerIdName"`. The value is resolved server-side, so the
  LLM can neither invent nor override it — see
  [Tool call chaining via metadata priming](./tool-call-chaining-metadata-priming.md)
  for the integrity model and the `redact` option.

### Trust boundary

`callerIdName` is **inbound data from the caller's equipment**, not something
your configuration asserts and not a verified identity. Whoever controls the
originating PBX or softphone can put any text there, including a name chosen
to impersonate someone or wording crafted to steer the LLM. Treat it as a
*claim*: fine for a greeting, never as authentication and never as the basis
of an authorization or routing decision, and expect it to be missing, stale,
a bare number, or nonsense. The same caveat applies to `sipHeaders`; see the
[trust boundary](./sip-headers.md#trust-boundary) there.

---

## How it works under the hood

- **LiveKit.** The inbound SIP trunk is created — and, if an existing trunk is
  found with a different setting, updated — with
  `includeHeaders = SIP_ALL_HEADERS` (see `lib/initialise.ts`), so LiveKit maps
  **every** INVITE header onto a `sip.h.<name>` participant attribute (name
  lowercased). That is what puts the raw `From` value in `sip.h.from`. When the
  worker sets up the inbound call it parses the display-name out of that
  attribute (`parseSipDisplayName` in `lib/sip-attributes.ts`, handling both
  the quoted-string and bare-token forms) and stamps it on the `aplisay`
  metadata. `aplisay.sipHeaders` is unaffected: it still collects only the
  `sip.h.x-*` subset. *Deploy note:* the trunk option lives in the LiveKit
  trunk configuration, which is written by the setup CLI
  (`node dist/realtime.js setup`, see `agents/livekit/README.md`), not by the
  worker at run time. Re-run the setup CLI once after deploying this change:
  it now updates an existing trunk whose `includeHeaders` differs, and until
  that has happened the worker sees no `sip.h.from` attribute and simply
  omits `callerIdName`. Every INVITE header then becomes a participant
  attribute of the caller.

- **Pipecat / sipbridge.** The Go bridge parses the INVITE's `From` with sipgo
  and forwards the display-name on the WebSocket opening handshake as
  `X-Sipbridge-From-Name`, **percent-encoded** (RFC 3986) so a non-ASCII name
  survives the HTTP header (the worker's HTTP stack decodes header bytes as
  latin-1). The worker unquotes and normalises it into the inbound call
  context. The header is sipbridge transport metadata rather than an INVITE
  header, so — like the other `X-Sipbridge-*` headers — it is excluded from
  `aplisay.sipHeaders`.

- **Pipecat / voiceblender.** The gateway reads an optional `from_display_name`
  field on the `leg.ringing` VSI event into the inbound call context.
  Voiceblender's SIP ingress currently reduces the `From` header to its bare
  user part (`from`), so until it also emits the display-name, voiceblender
  calls carry no `callerIdName`.

All paths apply the same normalisation (unquote, resolve `\` escapes, drop
control characters, collapse whitespace, omit when empty), so the value is
identical whichever ingress a call arrived on.

## See also

- [`prompt-metadata.md`](./prompt-metadata.md) — stating `aplisay.*` facts in
  the prompt.
- [`sip-headers.md`](./sip-headers.md) — the custom `X-` headers on the same
  INVITE.
- [`tool-call-chaining-metadata-priming.md`](./tool-call-chaining-metadata-priming.md)
  — `source: "metadata"` parameters and `redact`.
