# Release 0.9.57 (draft) - caller ID name, WebRTC join metadata, call-log limits, call-setup retries

> Draft. Covers changes merged to `next` since the 0.9.56 release point
> (10 pull requests, 6 - 9 October 2026). The version number is
> provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Caller ID name - core+livekit+pipecat+sipbridge

- **[livekit+pipecat] Where it works**: LiveKit inbound SIP calls, and Pipecat
  calls through sipbridge. Voiceblender, FreeSWITCH and Daily calls, outbound
  calls, WebRTC sessions, and `jambonz:`, `ultravox:` and `text:` agents carry
  no name.
- **[livekit+pipecat+sipbridge] `aplisay.callerIdName`** holds the display-name
  from the inbound INVITE's `From` header, unquoted and with whitespace
  collapsed. It is present only when the `From` carries one, and handovers keep
  it. It is what the caller's equipment sent, not a verified identity.
- **[livekit] Inbound trunk headers**: the setup CLI now sets the inbound trunk
  to `includeHeaders = SIP_ALL_HEADERS`, was `SIP_X_HEADERS`, and updates an
  existing trunk whose setting differs. `aplisay.sipHeaders` still holds only
  the `X-` headers.
- **[sipbridge] `X-Sipbridge-From-Name`** carries the display-name to the
  worker on the WebSocket handshake, percent-encoded. It is not copied into
  `aplisay.sipHeaders`.
- **[core] Documentation**: new [caller-id-name.md](../caller-id-name.md).

## WebRTC joins - core+livekit+pipecat

- **[core+livekit+pipecat] Join metadata**: `options.metadata` on
  `POST /listener/{listenerId}/join` now reaches LiveKit and Pipecat calls,
  merged over the listener activation's metadata as on `ultravox:`. Tool
  parameters with `source: "metadata"` can read it; it cannot override `aplisay`.
- **[core+livekit+pipecat] Join token**: join metadata travels encrypted in the
  join token, so the browser can neither read nor change it. A value the worker
  cannot open is logged and the call goes on without it. Metadata of several KB
  may exceed URL size limits.
- **[core+livekit] LiveKit rooms**: each LiveKit join gets its own room and
  participant identity, so a second join on a listener is a second call with its
  own agent. Before, it disconnected the first caller and got no agent. A
  reconnect after the call has ended gets a new call record.
- **[core] LiveKit join response** carries `callId`, the id of the call record,
  and the room's real `roomName`. The Pipecat join response has no `callId`.

## Agents and voices - core+livekit

- **[livekit] Slow tool calls**: an Ultravox reply whose tool calls take 10 s or
  more is played in full again. Since 0.9.56 the audio after those calls was
  dropped, though the transcript had it. LiveKit realtime models have no audio
  idle limit; pipeline agents keep the SDK's 10 s limit.
- **[core+livekit] Optional metadata parameters**: on LiveKit and text agents, a
  `source: "metadata"` parameter with `required: false` whose path is missing
  takes its `default`, or is left out, instead of failing the tool call. It never
  takes a value from the model. Without `required: false` the call still fails.
- **[core] Ultravox voices** are refreshed every ten minutes, like other
  vendors' voices, so a new or cloned voice reaches voice lists, agent-save
  validation and `options.tts.speed` without an API restart. The list was
  loaded once per process.
- **[core] LiveKit voice list** keeps its OpenAI and xAI voices when the
  Ultravox fetch fails, as Pipecat's already did.

## API load and call setup - core+livekit

- **[core] Call-log rate limit**: `GET /calls/{id}/logs` and
  `GET /calls/{id}/invocation-log` share a limit of 60 requests a minute per
  user, counted per API instance; an API key counts as its owner. Over it the
  API answers `429` with `Retry-After`.
- **[core] Call-log concurrency**: each API process runs at most
  `CALL_LOG_MAX_CONCURRENT` of those reads at once, by default half the
  database pool and always below it. Over that, a request waits up to 2 s for a
  slot, then gets `503` with `Retry-After`.
- **[core] Database pool**: `POSTGRES_POOL_MAX`, `POSTGRES_POOL_MIN`,
  `POSTGRES_POOL_ACQUIRE_MS` and `POSTGRES_POOL_IDLE_MS` set the API's pool per
  process. Defaults are unchanged (5 connections). Before raising it, check
  instances times `max + 1` against the database's connection limit.
- **[core] Log indexes** (schema v67): `transaction_logs` and `invocation_logs`
  are indexed on `call_id`, so call-log reads and call hooks no longer scan the
  whole table.
- **[livekit] Call-setup lookups**: the worker retries a lookup that times out
  or gets 5xx, 408 or 429, within one 45 s budget per call, instead of failing
  after 5 s, so the caller keeps ringing instead of hearing busy. A 404 or a
  trunk mismatch still ends the setup at once.
- **[core] Documentation**: new
  [db-pool-and-bulk-reads.md](../db-pool-and-bulk-reads.md).

## Upgrade notes

- **[core] Database schema migrates from v66 to v67**: v67 indexes `call_id` on
  `transaction_logs` and `invocation_logs`. It needs `DB_FORCE_SYNC` or
  `tools/agent-admin.js upgrade-db`. The indexes build without blocking writes,
  but on a large table the upgrade takes longer than a column add.
- **[core] New optional environment**: `CALL_LOG_RATE_LIMIT`,
  `CALL_LOG_RATE_WINDOW_MS`, `CALL_LOG_MAX_CONCURRENT`, `CALL_LOG_QUEUE_WAIT_MS`,
  `CALL_LOG_QUEUE_MAX`, `POSTGRES_POOL_MAX`, `POSTGRES_POOL_MIN`,
  `POSTGRES_POOL_ACQUIRE_MS`, and `POSTGRES_POOL_IDLE_MS`.
- **[livekit] New optional environment**: `CALL_SETUP_LOOKUP_BUDGET_MS`,
  `CALL_SETUP_LOOKUP_ATTEMPT_MS`, `CALL_SETUP_LOOKUP_MAX_ATTEMPT_MS`,
  `CALL_SETUP_LOOKUP_BACKOFF_MS`, and `CALL_SETUP_LOOKUP_MAX_BACKOFF_MS`.
- **[livekit] Trunk setup**: run the setup CLI (`node dist/realtime.js setup`)
  once in each environment after the worker deploy. Until then LiveKit calls
  carry no `callerIdName`.
- **[core+livekit] `LIVEKIT_API_SECRET`** must be the same on the API server and
  the LiveKit workers, or LiveKit WebRTC calls go on without join metadata.
- **[core] Call-log clients** must honour `Retry-After` on `429` and `503` from
  `GET /calls/{id}/logs` and `GET /calls/{id}/invocation-log`.
