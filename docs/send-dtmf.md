# Sending DTMF: the `send_dtmf` builtin

This document describes the builtin `send_dtmf` platform function, which lets a
voice agent play **DTMF digits** to the far end of a live telephone call as
**out-of-band** RFC 4733 (`telephone-event`) tones. It is written for API
users; for the runtime internals see
[`livekit-agent-architecture.md`](./livekit-agent-architecture.md),
[`sipbridge-integration.md`](./sipbridge-integration.md) and
[`voiceblender-integration.md`](./voiceblender-integration.md).

## Overview

`send_dtmf` makes the agent press keypad digits on the telephone call it is
already on. The tones are delivered **out of band** — as RFC 4733
`telephone-event/8000` RTP, the same signalling a physical phone keypad
produces — not as audible beeps mixed into the speech audio. That is what
downstream telephony equipment expects, and it survives transcoding and lossy
codecs that would corrupt in-band tones.

Typical uses:

- **Navigating a downstream IVR** on an outbound call — "press 1 for sales",
  entering an extension, or keying an account / reference / case number into an
  automated system the agent has dialled or been connected to.
- **Satisfying a keypad prompt** on the remote side of a call (e.g. a
  conferencing bridge or voicemail PIN).

The digit string is played **serially**, one digit at a time, with standard
telephony timing. The call stays up throughout — this is in-dialog signalling,
not a transfer or a hangup.

`send_dtmf` is the send counterpart to the platform's existing DTMF **receive**
handling (inbound keypad presses buffered and delivered to the LLM, tuned with
`options.dtmfTimeout` / `options.dtmfTerminator`). Receiving DTMF is available
on every telephony runtime; **sending** is LiveKit- and Pipecat-only.

### Where it works

| Capability | `livekit:` | `pipecat:` | `jambonz:` | `ultravox:` | `text:` |
|---|---|---|---|---|---|
| `send_dtmf` — play out-of-band RFC 4733 DTMF | ✅ | ✅ ¹ | ❌ | ❌ | n/a |
| …on a **WebRTC / browser** session | ❌ ² | ❌ ² | n/a | n/a | n/a |

¹ On Pipecat, out-of-band DTMF is emitted by the SIP gateway that owns the
media leg. The **sipbridge** and **voiceblender** gateways support it; the
**Daily** and **FreeSWITCH** gateways do not, and `send_dtmf` returns a
`FAILED` result explaining so on those. (The active gateway is chosen at worker
startup via `SIP_GATEWAY`.)

² A WebRTC/browser participant has no telephone leg to relay tones to, so
`send_dtmf` is **rejected at call time** with a `FAILED` result on both
runtimes. The function can still be *defined* on a LiveKit/Pipecat agent that
takes both telephone and browser calls — it simply errors on the browser ones.

Adding a `send_dtmf` function to a `jambonz:`, `ultravox:` or `text:` agent is
rejected when the agent is saved (`Model <name> does not support sending
DTMF …`).

---

## The `send_dtmf` function

Add a builtin function with `platform: "send_dtmf"` to a voice agent:

```json
{
  "name": "press_keys",
  "implementation": "builtin",
  "platform": "send_dtmf",
  "description": "Press digits on the phone keypad to navigate the menu or enter a number. Use the exact digits required, e.g. \"1\" or \"4930#\".",
  "input_schema": {
    "properties": {
      "digits": {
        "type": "string",
        "description": "The digits to press, using only 0-9, * and #."
      }
    },
    "required": ["digits"]
  }
}
```

As with every builtin, the function `name` and `description` are yours to
choose — they are what the LLM sees and reasons about. The `platform` value
selects the behaviour.

**Parameters:**

| Parameter | Source | Required | Description |
|---|---|---|---|
| `digits` | `generated` (default), `static` or `metadata` | Yes | The digits to play, over the alphabet `0-9`, `*` and `#`. Maximum 64 characters. |

Unlike the `transfer` function's `number`, `digits` **may be `generated`** — in
fact that is the common case: the LLM keys what it worked out during the call (a
menu choice it heard, or a number the caller gave it). Sending tones on the
call you are already on is not a redirect, so there is no anti-fraud constraint
on the parameter source. You can still pin it `static` (e.g. a fixed extension)
or source it from `metadata` if you prefer. When a `static` value is supplied it
is alphabet-checked as the agent is saved.

> RFC 4733 events A–D (codes 12–15) are intentionally **not** accepted: the
> platform's DTMF alphabet is `0-9`, `*` and `#` end to end.

### What happens on a call

- The digits are played **serially** to the remote party, each as a discrete
  out-of-band tone, with a short gap between them so the far end registers them
  as separate presses.
- On success the function returns `{ "status": "OK", "detail": "sent N DTMF
  digit(s)" }`. The LLM can narrate accordingly ("I've entered your reference
  number").
- Nothing about the audio path changes — the caller/agent conversation
  continues normally; the tones ride alongside it on the telephone leg.

### Errors

`send_dtmf` returns a `FAILED` result (it does not throw) so the LLM gets a
clean tool result it can react to:

| Condition | Result |
|---|---|
| Call is a WebRTC / browser session | `FAILED` — "DTMF can only be sent on a telephone (SIP) call, not a browser/WebRTC session" |
| `digits` empty / missing | `FAILED` — "send_dtmf requires a non-empty 'digits' string" |
| `digits` contains anything but `0-9 * #` | `FAILED` — "send_dtmf 'digits' may only contain the characters 0-9, * and #" |
| `digits` longer than 64 characters | `FAILED` — "send_dtmf 'digits' is limited to 64 characters" |
| Active Pipecat gateway can't send DTMF (Daily / FreeSWITCH) | `FAILED` — "DTMF send is not supported on the active SIP gateway" |

---

## Example: an outbound IVR-navigation agent

An agent that dials a supplier's automated line and keys through the menu:

```jsonc
{
  "prompt": "You are calling AcmeCorp's automated line to check an order. When you hear the menu, press 2 for 'existing orders', then key the order number 4021 followed by #. Read back what the system tells you.",
  "functions": [
    {
      "name": "press_keys",
      "implementation": "builtin",
      "platform": "send_dtmf",
      "description": "Press digits on the phone keypad. Pass only the digits to press, e.g. \"2\" or \"4021#\".",
      "input_schema": {
        "properties": {
          "digits": { "type": "string", "description": "Digits to press (0-9, * and #)." }
        },
        "required": ["digits"]
      }
    }
  ]
}
```

The LLM listens to the IVR audio, then calls `press_keys({ "digits": "2" })`,
and later `press_keys({ "digits": "4021#" })`. Each call plays the tones
out-of-band to AcmeCorp's system.

---

## How it works under the hood

The out-of-band tone always leaves on the SIP/RTP leg, but where that leg lives
differs by runtime:

- **LiveKit** — the agent calls `localParticipant.publishDtmf(code, digit)` for
  each digit. LiveKit's SIP service, which terminates the telephone leg, relays
  each event to the phone user as `telephone-event`. It works on both inbound
  and outbound calls; only a browser/WebRTC session — which has no telephone
  leg — is rejected.

- **Pipecat** — the media leg is owned by the configured SIP **gateway**, so the
  worker asks the gateway to emit the tones (`POST /v1/calls/{id}/dtmf` for
  sipbridge, `POST /v1/legs/{id}/dtmf` for voiceblender):
  - **sipbridge** (the bundled Go bridge) synthesises RFC 4733
    `telephone-event` RTP itself — a burst of packets per digit sharing one RTP
    timestamp, the marker bit on the first packet, a cumulative duration field,
    and a repeated end-of-event packet for loss resilience (sent on payload type
    101, which sipbridge advertises in its own SDP).
  - **voiceblender** asks the external media platform to emit the tones on the
    leg, mirroring its inbound `dtmf.received` path in the opposite direction.
  - **Daily** and **FreeSWITCH** gateways do not implement DTMF send today, so
    the builtin returns the "not supported on the active SIP gateway" error.

  Browser sessions (`SmallWebRTCTransport`) have no gateway leg, so the worker
  errors before reaching any gateway.

Both runtimes cap a single call to 64 digits and validate the alphabet before
anything is put on the wire.

## See also

- [`multi-agent-api.md`](./multi-agent-api.md) — the other builtin platform
  functions (`transfer_agent`, `subagent`, …) and the general builtin-function
  shape.
- [`call-transfers.md`](./call-transfers.md) — the `transfer` / `transfer_status`
  builtins and the SIP-vs-WebRTC distinction that also gates `send_dtmf`.
- [`sipbridge-integration.md`](./sipbridge-integration.md) /
  [`voiceblender-integration.md`](./voiceblender-integration.md) — the Pipecat
  SIP gateways that carry the out-of-band tones.
