# Chat session ownership across server processes

Interactive text-agent chat (`POST /agents/{agentId}/chat`, then the
`/chat/<id>` websocket) runs on a server that has more than one process:
autoscaled Kubernetes pods and Cloud Run instances. The websocket for a
session can reach any of them, on the first connect and on every reconnect.
This document describes how a session moves between processes. The code is in
`lib/text-chat.js`.

## The model

A session is a row in `chat_sessions`. Exactly one process holds it in memory
at a time, and the row says which one (`owner`, a process id from
`lib/process-id.js`: pod name or hostname, pid, and a random boot suffix).

- `POST /agents/{agentId}/chat` writes the row with `owner = NULL` and the
  seed (the set to edit, a test result, a knowledge block, a resume history)
  in `state.seed`. Nothing is built at this point.
- The process that receives the websocket upgrade claims the row (a
  conditional `UPDATE ... WHERE owner IS NULL`), builds the driver there and
  runs the conversation.
- At every turn boundary the holder writes a snapshot to `state`: the
  driver's replayable conversation (`exportConversation()` on
  `lib/models/*`), a paused interactive ask, frames buffered while no socket
  was attached, the set being worked on, and whether the opening turn has
  completed.
- Every write the holder makes is conditional on `owner = <its id>`. A write
  that changes no row means another process has taken the session, and the
  holder drops it locally without ending anything.

## Reconnect on another process

When a socket for a session arrives at a process that does not hold it:

1. If the row is unowned, or its holder's heartbeat (`last_seen_at`) is
   stale, the process claims it at once and rehydrates the driver from the
   snapshot (`importConversation()`). The client sees one `attached` frame
   with `resumed: true`.
2. If the holder is alive, the process sends it a `release` request over
   Postgres `LISTEN/NOTIFY` (channel `chat_control`) and waits for the row to
   become unowned, polling every 100 ms. The client is sent a provisional
   `attached {resumed: true, busy: true}` frame straight away, because
   polite-ai's client gives a re-attach five seconds to prove itself; the
   real `attached` follows once the session is rehydrated and corrects the
   busy indicator.
3. A holder at rest releases immediately: it writes its final snapshot and
   `owner = NULL` in one conditional write, closes its driver (and any
   standing MCP connections), tells any socket it still has that it was
   superseded, and forgets the session. A holder mid-turn answers `busy`,
   finishes the turn, and releases at the turn boundary; the waiting process
   extends its wait so the turn's reply is kept.
4. A holder that has not released when the wait runs out is treated as gone
   and the row is taken from it. Its next conditional write tells it so.

Replaying a byte-identical conversation is what lets the provider prompt
cache serve the prefix: a handover costs cache reads, not a rebuilt seed.

## Shutdown

On `SIGTERM` a process releases every session it holds
(`releaseAllChatSessions`). The clients whose sockets die with it reconnect
through the load balancer to another process, which claims the unowned rows
and carries on. A rolling deploy therefore hands sessions over rather than
losing them; a turn in flight at that moment loses its reply, and nothing
else.

## Retention

Builder sessions (the `builtin:set-builder`, or an org-pushed builder marked
`[polite:agent-builder]`) are history: their rows stay, with the transcript,
after the session ends. Every other text agent's conversation is a tenant's
own end-user data. Its row exists only while the session is live
(`ephemeral = true`), is deleted when the session ends, and is never listed
by `GET /chat-sessions`. The reaper (`reapStaleChatSessions`) removes ended
ephemeral rows an owner never got to.

The snapshot is cleared (`state = NULL`) when a session ends. `owner` and
`state` are not part of the API.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `POD_NAME` | `HOSTNAME`, else the machine hostname | The human-readable part of the process id in `owner`. Kubernetes sets `HOSTNAME` to the pod name, so this is optional. |
| `TEXT_CHAT_HANDOFF_WAIT_MS` | `5000` | How long a claim waits for a live holder to release before taking the row. |
| `TEXT_CHAT_HANDOFF_BUSY_WAIT_MS` | `90000` | The wait when the holder has answered `busy` (a turn in flight). |
| `TEXT_CHAT_STATE_MAX_BYTES` | `4194304` | Snapshot size cap. Over it the conversation is left out and a takeover resumes from the transcript. |
| `TEXT_CHAT_LIVENESS_GRACE_MS` | `300000` | Existing: a holder whose heartbeat is older than this is treated as dead. This is also the window in which a session whose process died can still be taken over; after it the reaper ends the row and the client falls back to a fresh session. |
| `TEXT_CHAT_REATTACH_GRACE_MS` | `900000` | Existing: how long a holder keeps a session after its socket drops. |

## Schema

Columns on `chat_sessions`, added idempotently at boot
(`ADD COLUMN IF NOT EXISTS`, the same way `last_seen_at` was): `owner`
(varchar), `state` (jsonb), `ephemeral` (boolean, not null, default false).
No `schemaVersion` bump, so no manual upgrade step per environment.

## Tests

`tests/chat-session-handoff.test.mjs` runs the protocol against a second,
real node process (`tests/fixtures/chat-peer.mjs`) sharing the test
database: first attach, live takeover with the conversation intact, the
return trip, a dead holder, an unresponsive holder, the fencing write, and
retention. `tests/fixtures/fake-chat-llm.mjs` stands in for a provider and
implements the same export/import contract the real drivers do.
