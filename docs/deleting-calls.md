# Deleting calls

`DELETE /calls/{callId}` deletes the caller data and content of a call. It
keeps a billing record of the call.

## What it deletes

The request works on the whole conversation. A call can have several legs:
a handover to another agent, a transfer or a bridged leg is a new call row
whose `parentId` is the call it came from. Every leg holds the caller number
and its own transcript, so deleting any leg deletes all of them. The response
lists every leg it deleted:

```json
{ "callIds": ["648aa45d-...", "632555d8-..."] }
```

For each leg it removes:

- the caller and called numbers;
- the call metadata (SIP headers, caller name) and the copy of the agent
  options;
- the transcript, call events and invocation log;
- the recording and its encryption key.

## What it keeps

Each leg keeps its ID, organisation, user, agent, model, trunk, start and end
times, duration and status. Its usage records are not changed. They hold the
cost and, for a chargeable outbound leg, the dialled number that was billed.

A deleted call is left out of every call read. `GET /calls?redacted=include`
lists deleted calls with the rest, and `?redacted=only` lists only them. A
deleted call shows `redactedAt` and its billing fields.

## When it refuses

- `409 call_in_progress`: a leg is in progress, or ended less than 15 minutes
  ago. Some data (the invocation log, the recording) arrives just after a call
  ends, and deleting first would let it come back. The response names each leg
  in `blockers`. A leg with no end after 24 hours counts as stuck and does not
  block.
- `404`: the call is not in your scope, or is already deleted.
- `503 call_redaction_not_ready`: the database lacks schema 78. Run
  `node tools/agent-admin.js upgrade-db`, then restart the API server.

A worker that writes to a deleted call (a transcript line, an invocation log, a
recording) gets `410 call_redacted`, and nothing is stored. A recording the
worker has already uploaded is deleted.

## Permission

`call: delete`. Owners, organisation admins and super admins hold it.

## What it does not reach

- Copies at a model provider. Ultravox keeps each call until it is deleted,
  and we do not store the Ultravox call ID, so a single call cannot be deleted
  there. `node tools/agent-admin.js purge-ultravox-calls` deletes Ultravox
  calls older than a cutoff.
- Server logs and database backups. They expire on their own schedules.
