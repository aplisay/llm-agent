# Transfer-back delivery plan

> Status: **agreed 2026-08-05** · scope: **pipecat only** (LiveKit code for these
> features exists but is unverified and out of scope; option shapes stay
> topology-neutral so LiveKit can follow later) · execution branch:
> `transfer-back`

"Transfer back" lets the human target of a bridged transfer key a programmed
DTMF code to hand the caller back to an agent that knows everything that has
happened so far — the pre-transfer conversation, the human↔human bridged
segment, and (optionally) an application-controlled summary of both.

This document records what already exists on `next`, the decisions taken, and
the work packages that deliver the rest.

## 1. What already exists on `next`

Most of the mechanism shipped in PR #129 (`transfer-out`, rolled up in PR #136,
merged 2026-07-03) and PR #178 (`promptMetadata`):

| Piece | State | Where |
|---|---|---|
| `options.bridgedTransferToAgent` — DTMF map `{"1": "label:followup"}`, codes `[0-9*#]{1,8}`, multi-digit + `dtmfTimeout` window, per-code targets, agent-set `label:` resolution | merged | `lib/database.js`, `lib/agent-set-labels.js`, [call-transfers.md](./call-transfers.md) |
| Target-keypad-only detection (RFC 4733 on the target leg; sipbridge emits `source:"transfer_target"` on the monitor WS; voiceblender keys watchers by target leg id) | merged | `sipbridge internal/call/manager.go`, `pipecat_aplisay/bridged_transfer.py` |
| Blind **and** consultative coverage — the option forces the bridged path (never REFER) | merged | `call_session.py` `_on_transfer` |
| Safe takeover ordering — child call + concurrency slot reserved before unbridge; failure leaves the humans connected, code retryable | merged | `bridged_transfer.py` `prepare_takeover` |
| `options.bridgedTransferTranscribe` — sipbridge stereo tap → two STT streams (agent's STT vendor); voiceblender native per-leg STT; turns logged on a `telephony:bridged-call` child call (`type:"user"` = caller, `"agent"` = human target) | merged | `bridge_transcript.py`, `sipbridge internal/call/tap.go` |
| Takeover prompt injection of both transcripts, gated by `includeHistory` (default `true`) | merged | `bridged_transfer.py` `compose_takeover_prompt` |
| `promptMetadata` (re-resolved on every session including takeover), `get_metadata`, agent sets, `transferPrompt` `${parentTranscript}`, `transfer_status`, `transferTone`, `GET /calls/{id}/linked` | merged | various; [prompt-metadata.md](./prompt-metadata.md), [multi-agent-api.md](./multi-agent-api.md) |
| Worked example doc (front desk → engineer → press `1` → follow-up books the visit) | merged | [human-handback-howto.md](./human-handback-howto.md) |

**Not yet live-call verified.** Unit tests and builds only. PR #191 subsequently
fixed trunk-origin bridged transfers (previously a hard 502) and added the RTP
pacer to the unbridge re-attach path; PR #192 changed SRTP offer handling on
the transfer leg. Phase 0 below re-verifies the base on today's code.

## 2. Decisions (Rob, 2026-08-05)

1. **Keep direct prompt injection** as the only transcript→prompt path, gated
   by `includeHistory` which **stays default `true`**. The `promptMetadata`
   500-char value cap is not challenged (no `maxChars` work).
2. **Always seed transcripts into metadata** (`aplisay.transfer.*`),
   independent of `includeHistory` — that switch governs the prompt only.
   Out-of-band exposure is controlled by which tools the successor agent has;
   leaving `bridgedTransferTranscribe` unset remains the true kill-switch for
   the human segment.
3. **No platform-baked summarisation.** Summarisation is an application
   pattern: a `text:` summariser agent in the agent set, invoked via the
   existing `subagent` builtin with transcript parameters sourced from
   metadata — out-of-band of the successor's LLM context, prompt-focusable,
   format-controllable, and billed to the org's own token usage.
4. **Build the streamline in v1**: `summaryAgent` on the hand-back map entry
   pre-fires the summariser at DTMF-match time, and a new `transfer_summary`
   builtin lets the successor collect the pending result. One summariser
   definition serves both the playbook and pre-fire modes.
5. **Listener-level override** of `bridgedTransferToAgent` /
   `bridgedTransferTranscribe` / `dtmfTimeout`, wholesale-replacing the
   agent-level values (mirrors the existing `recording` instance override).
6. **Recording of the bridged segment is sipbridge-only**; voiceblender is a
   documented restriction (its native STT returns text, not audio, and VB
   recording is deliberately disabled).
7. **Documented gaps, no code**: carriers that strip RFC 4733 (hand-back
   silently unavailable — no in-band decoder); PCMU↔PCMA cross-family bridge
   rejection (forced-bridge fails where a REFER would work; trivial G.711
   table transcode if it ever matters); WebRTC-origin exclusion.

## 3. Work packages

### Workstream 1 — llm-agent API + pipecat worker

**WP1.1 — Listener-level override (S/M).** Accept `bridgedTransferToAgent`,
`bridgedTransferTranscribe`, `dtmfTimeout` in listener options; when present,
each **wholesale-replaces** the agent-level value. Validation reuses the agent
switch in `lib/database.js`; `label:` values resolve at listen time against
the agent's set; the worker merges via a helper mirroring
`_resolve_recording_options`. Touches `lib/database.js`, `api/api-doc.yaml`
listener options schema, `call_session.py`, tests.

**WP1.2 — Always-seed `aplisay.transfer.*` (S).** `prepare_takeover` seeds the
takeover call's metadata with `parentTranscript`, `bridgeTranscript`,
`consultTranscript` (consultative only), `key`, `targetNumber`; transcripts
tail-truncated (~32k chars) to protect the row. Same `> speaker:` rendering as
the prompt sections. Docs steer consumers to `includeHistory` for prompts and
`source: "metadata"` parameters for out-of-band use — **not** `get_metadata`
on transcript keys (it would dump the text into a live voice context).

**WP1.3 — Summariser playbook enablement (S/M).** Verify `source: "metadata"`
parameter resolution on `subagent`-platform functions in the pipecat worker
(generic layer, unexercised combination) and fix if needed. Build the
reference pattern as a test: summariser `text:` member; successor carries
`summarise_call` (`platform: "subagent"`, target `label:summariser`) with
metadata-sourced transcript params; summary returns as a tool result.

**WP1.4 — `summaryAgent` pre-fire + `transfer_summary` builtin (M).**
- Map-entry object gains `summaryAgent: "<uuid>|label:x"` (validated and
  label-resolved like `agent`).
- `prepare_takeover` fires the summariser **asynchronously** at match time
  (overlaps goodbye + unbridge). A summariser failure or slow run never
  blocks or aborts the takeover.
- Invocation contract: the platform composes the same labelled-transcript
  message the WP1.3 function shape produces — one summariser definition,
  both modes. Billing lands on the org's text-agent usage records either way.
- `transfer_summary` platform builtin: waits up to a timeout (default ~5 s,
  capped) for the pending result; returns the summary or a clear
  `not ready` / `failed` status the agent can act on.

**WP1.5 — Bridged-segment recording, sipbridge only (M).** Fan the tap's
audio frames into a `RecordingSession` keyed to the bridged call record —
stereo, left = caller / right = target. Arm `tap_audio` when either
transcription or recording wants it; gate on the original call's effective
recording setting; stamp `recordingId` on the `telephony:bridged-call` row.

**WP1.6 — Documented gaps (S, docs only).** The rule-7 list above, in
[call-transfers.md](./call-transfers.md) caveats/topology and
[sipbridge-integration.md](./sipbridge-integration.md).

**WP1.7 — Tests + live verification.** Extend the pipecat suites (listener
merge, metadata seeding, subagent sourcing, pre-fire/builtin, tap fan-out) and
Node validation tests; Phase 0 and the Phase 5 E2E below.

### Workstream 2 — documentation

Extend [human-handback-howto.md](./human-handback-howto.md) (summariser
member, metadata/OOB flow, `summaryAgent` + `transfer_summary` variant,
greet-first latency masking) keeping the diary-entry storyline. Update
[call-transfers.md](./call-transfers.md) (listener override, `summaryAgent`,
recording column, caveats), [prompt-metadata.md](./prompt-metadata.md)
(`aplisay.transfer.*` paths + `get_metadata` steer),
[call-recording.md](./call-recording.md) (bridged section, sipbridge-only),
[agent-sets-and-subagents.md](./agent-sets-and-subagents.md) (hand-back +
summariser mention), release notes.

### Workstream 3 — polite-ai builder + agent configuration

- Playbook §"Human hand-back & bridged transcription" refresh (listener
  override, metadata keys, summariser pattern, `transfer_summary`,
  sipbridge-only recording); reviewer sync; extend the `ht-human-handback`
  bench scenario (or add `ht-handback-summary`). Bootstrap/tool-schema edits
  re-push every org's builder via `definitionHash` — time with a release.
- Agent detail drawer: a **Hand-back** section in "Tools & transfers" —
  repeating rows of DTMF code → target picker (set members by `label:`,
  standalone by UUID), per-row `includeHistory` and `summaryAgent`, plus a
  transcription switch and `dtmfTimeout`. Overlay in `agent-patch.server.ts`
  with delete-on-empty; faithful-posting discipline. First map-shaped option
  in the drawer → dedicated sub-component.
- Team graph: `"handback"` edge kind derived from the option (labelled with
  the key). The summariser link renders for free as an existing `subagent`
  edge.
- Listener-override UI: deferred (API-first); later home is the numbering
  panel.

### Workstream 4 — polite-ai calls panel

Bridged legs already appear (via `GET /calls/{id}/linked`) and their turns
already render (plain `user`/`agent` transaction-log rows) — the work is
presentation truthfulness: leg-kind detection via
`modelName === "telephony:bridged-call"`; human-leg labelling in list, chips
and journey string; speaker relabel + distinct styling in the bridged
transcript pane; status badge for `Transfer target handed call back…`; honest
no-recording copy until WP1.5 ships; include the bridged leg in the
diagnostics bundle; order sibling legs by `startedAt` + the
`aplisay.bridgeOf` / `aplisay.bridgedTransferToAgent` markers (the takeover
record's `parentId` is the *original* call, not the bridged segment). The
summariser call and result surface in the successor leg's invocation log via
the existing tool-call logging.

## 4. Sequencing

1. **Phase 0** — live-verify the merged base on beta PSTN: both gateways,
   blind + consultative, per the
   [howto testing checklist](./human-handback-howto.md#testing-checklist).
2. **Phase 1** — WP1.1 + WP1.2 (+ WP1.6 docs alongside).
3. **Phase 2** — WP1.3, then WP1.4.
4. **Phase 3** — WP1.5.
5. **Phase 4** — polite-ai: calls panel from Phase 0; drawer/builder after
   Phase 1–2 shapes settle.
6. **Phase 5** — docs finalisation, release notes, full live E2E of the
   worked example including the summariser.

## 5. Risks

Carrier RFC 4733 stripping (documented, undetectable in-band today); codec
cross-family bridges (hard error, documented); summariser latency (bounded by
`transfer_summary` timeout; maskable by greeting first); voiceblender
recording out of reach in v1; LiveKit parity drift (kept shape-compatible,
not implemented here).
