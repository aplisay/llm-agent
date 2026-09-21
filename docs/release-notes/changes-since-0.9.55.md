# Release 0.9.56 (draft) - Ultravox hangup fix

> Draft. Covers changes merged to `next` since the 0.9.55 release point
> (1 pull request, 19 - 21 September 2026). The version number is
> provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Agents and models - livekit

- **[livekit] Ultravox hangup**: the `hangup` builtin's result now tells
  Ultravox to listen (`agentReaction: "listens"`), including after an in-place
  handover. The model no longer calls `hangup` again, and the call ends without
  a silent gap. Other tools keep Ultravox's default.

## Upgrade notes

- **[core] Database schema** stays at v66. There is no new environment.
