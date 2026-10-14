# Release 0.9.58 (draft) - transcript times

> Draft. Started with the transcript timing change. The other pull requests
> merged to `next` since the 0.9.57 release point (#409 to #415, #417) are not
> in it yet. The version number is provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Transcript times - core+livekit

- **[livekit] `user` entry `createdAt`** is now when the caller stopped speaking
  for that turn, as `agent` entries already give the time the agent stopped. It
  was the time the transcript reached the worker, up to about 1.3 s later on
  Ultravox and after the start of the agent's reply. A `user` entry now comes
  before the reply and the tool calls it caused.
- **[livekit] `streamLog`**: when streamLog is used to stream logs during the
  call, these are provisional and may differ from the fully reconciled logs
  recorded at the end of the call.
- **[core] `POST /api/agent-db/call/{callId}/end`** accepts
  `transactionLogCorrections`, `[{ id, createdAt }]`, and applies them before
  the end call hook is sent.
- **[livekit] `TRANSCRIPT_USER_TIME=arrival`** in the worker environment
  restores the old transcript-arrival time.
