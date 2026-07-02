# LiveKit ↔ Pipecat transfer feature parity

Status as of the `transfer-out` branch (July 2026). This note records the
feature-compatibility analysis between the LiveKit agent worker
(`agents/livekit`) and the Pipecat agent worker (`agents/pipecat`) on its two
production SIP topologies — the **sipbridge** container
(`agents/pipecat/sipbridge`, Go) and the **voiceblender** container (separate
repo, REST + VSI) — with a focus on call transfers.

## Parity matrix

| Capability | LiveKit | Pipecat + sipbridge | Pipecat + voiceblender |
|---|---|---|---|
| Blind transfer, SIP REFER | ✅ `transferParticipant` (telephony.ts) | ✅ `mode: "blind"` in-dialog REFER | ✅ `POST /v1/legs/{id}/transfer` |
| Blind transfer, bridged (media stays on platform) | ✅ SIP participant into the caller room | ✅ `mode: "dial_bridge"` (agent-less leg + in-process RTP relay) | ✅ agent-less leg + ephemeral room |
| Consultative (warm) transfer — TransferAgent consult phase | ✅ | ✅ | ✅ |
| Consultative finalise, bridged | ✅ `moveParticipant` into caller room | ✅ `mode: "bridged"` relay | ✅ room bridge |
| Consultative finalise, attended REFER-with-Replaces | ✅ | ✅ `mode: "attended"` | ❌ — falls back to media bridge (voiceblender's transfer API takes `replaces_leg_id`, but the worker integration for the consult finalise is not wired; the bridged fallback is used) |
| Transfer mode selection (origin defaults + `forceBridged`/`forceRefer` + endpoint options) | ✅ | ✅ | ✅ |
| `transfer_status`, `transferPrompt`, `consultFeedback`, `callerId` override, outboundCallFilter | ✅ | ✅ | ✅ |
| Confidence tone (`options.transferTone`) | ✅ | ✅ | ✅ |
| WebRTC (browser) origin transfers | n/a (LiveKit rooms native) | ✅ worker-side media relay | ✅ worker-side media relay |
| Bridged call record for the post-transfer segment | ✅ child call, `modelName: "telephony:bridged-call"` | ❌ not created (follow-up) | ❌ not created (follow-up) |
| Human-to-agent transfers (`options.bridgedTransferToAgent`) | ✅ (this branch) | ✅ (this branch) | ✅ (this branch) |

**Conclusion:** bridged warm (consultative) and cold (blind) transfers between
two SIP endpoints are supported on all three topologies. The remaining
genuine deltas are (a) voiceblender's attended-REFER finalise (a REFER
optimisation, not a bridged-transfer gap) and (b) the missing bridged-segment
call record on the Pipecat topologies (billing/CDR parity follow-up).

## Defects found and fixed during this analysis

The Pipecat *native bridge* API surface existed on both gateways, but the
end-to-end semantics had two teardown defects that would have collapsed a
bridge shortly after it was installed:

1. **sipbridge (Go)** — `SetPeer` stops the leg's worker WebSocket, and the
   WS close handler unconditionally called `Call.Close()`, tearing down the
   caller's RTP session the moment a relay was installed. Fixed: the close
   handler leaves a call alone while it is in relay mode; additionally, when
   one leg of a bridged pair receives a BYE, the peer leg is now hung up too
   (previously it leaked until the media timeout), and bot audio arriving on
   a kept-open WS is never mixed onto a bridged call.
2. **Pipecat worker** — `_run_session`'s teardown called
   `gateway_session.shutdown()` unconditionally, which `DELETE`d the caller's
   gateway leg after the pipeline ended — i.e. immediately after a bridged
   transfer. Fixed: gateway sessions are marked `bridged` when a relay/room
   bridge is installed and their `hangup()` becomes a no-op (the bridged call
   belongs to the two humans and lives until either side BYEs).

Also fixed in passing: RFC 4733 packets are no longer forwarded across the
sipbridge relay re-stamped with the audio payload type (they were audible as
a brief noise blip and useless as signalling).

## Human-to-agent transfers

`options.bridgedTransferToAgent` (added on this branch, all three topologies)
lets the transfer target hand the caller back to an AI agent by DTMF after a
bridged transfer. Full contract in
[`call-transfers.md`](call-transfers.md#human-to-agent-transfers-bridgedtransfertoagent);
per-topology mechanics in
[`sipbridge-integration.md`](sipbridge-integration.md) and
[`voiceblender-integration.md`](voiceblender-integration.md). Common design:

- The option forces transfers onto the bridged path (REFER would take the
  call off-platform, out of DTMF sight).
- Only the **transfer-target leg's** DTMF is watched; multi-digit sequences
  use `options.dtmfTimeout` (default 1500 ms) inter-digit semantics.
- On a match: the continuation child call record is reserved **first**
  (concurrency-safe — a busy target agent aborts the takeover and leaves the
  humans connected), then the target leg is dropped and the mapped agent's
  stack starts on the caller leg with configurable history carry
  (`includeHistory`, default true).
- In agent-set documents the map values participate in `label:` substitution
  (`lib/agent-set-labels.js`).

Known limitation: not available for WebRTC-origin (browser) calls, whose
transfers ride the worker-side media relay.
