# Fixed fallback message — shared contract

This document is the single source of truth for the cache layout and audio
format used by the fixed-message failover path (`options.fallback.message`).
Two implementations follow it:

- **JS** — this directory (`lib/fallback-message/`), consumed by the LiveKit
  agent via the `agent-lib/` symlink.
- **Python** — `agents/pipecat/pipecat_aplisay/fallback_message/`, a sibling
  implementation. Different language, same contract.

Both runtimes read and write the *same* objects. A change made on one side and
not the other does not corrupt anything — it splits the cache in two, so each
runtime silently re-synthesises what the other already paid for. If you change
anything here, change both sides and update
`tests/lib/fallback-message.test.mjs` and
`agents/pipecat/tests/test_fallback_message.py`.

## Why there is a cache at all

The announcement never varies for a given configuration, so it is synthesised
once and replayed thereafter. That is not only a latency and cost win: it is
what keeps the playout path free of any billing interaction. A cache hit makes
no vendor call, so it meters nothing, so it needs no `Call` record, so it never
touches the concurrency limiter — which matters because the single most useful
time to play a fixed message is when that limiter is the thing rejecting the
call. See `docs/agent-failover.md` for the full argument.

## Cache key

Content-addressed. The key is the first 32 hex characters (128 bits) of
`sha256(canonical)` where `canonical` is the UTF-8 JSON encoding of exactly:

```json
["<text>", "<vendor>", "<voice>", "<language>"]
```

Absent fields are the empty string, never `null` or omitted. Fields are hashed
as a JSON array rather than a delimited string so a value containing the
delimiter cannot collide with a different field split.

`options.fallback.message` is always an object — there is no bare-string
shorthand, and both runtimes resolve a string to `null` rather than treating it
as `{ text }`.

`text` is whitespace-trimmed. `vendor`, `voice`, and `language` are resolved
against the agent's own `options.tts` before hashing, so an agent that states
only `text` hashes with its normal TTS settings filled in.

### Inheritance is conditional, and both runtimes must agree

`vendor` and `voice` are inherited from `options.tts` **only when the agent has
a discrete TTS** — that is, when its voice mode is `pipeline`. A realtime
speech-to-speech agent's `options.tts.voice` names a timbre of the *model*
(`"Svetlana"` on Ultravox), which no TTS can render; inheriting it would hand
the TTS builder a vendor of `ultravox`, which raises rather than degrading. So
for realtime agents those two fields resolve to empty and the worker's default
TTS is used unless the message states its own.

`language` is inherited either way — a BCP-47 tag means the same thing to a
model and to a TTS.

Each runtime derives this from its own voice-mode resolver
(`resolveVoiceMode` / `resolve_voice_mode`, both of which honour
`options.voiceMode`). **This decision feeds the key**, so a runtime that decided
it differently would split the cache exactly as a hashing difference would. The
cross-language test pins realtime cases for this reason.

Consequences, both intended:

- Editing any of the four inputs changes the key, so invalidation is automatic.
  There is no cache to bust and no way to serve stale audio for edited text.
- Two agents with an identical announcement in an identical voice share one
  object. Safe: the content is fully determined by the key, so computing the
  key requires already holding the plaintext, and the bucket is platform-private.

## Storage layout

Base URL resolution, in order:

1. `FALLBACK_MESSAGE_STORAGE_PATH` if set.
2. The bucket from `RECORDING_STORAGE_PATH` (if set) with prefix
   `<NODE_ENV>-fallback-messages` — so a deployment that has already moved
   recordings to its own bucket does not keep writing announcements to the
   default one.
3. `gs://llm-voice/<NODE_ENV>-fallback-messages`.

Object name: `<prefix><key>.wav`.

Objects are stored **unencrypted**, unlike recordings, and deliberately so.

There is nothing to protect: a recording is customer conversation audio, held
under a key the platform sometimes does not have, whereas an announcement is
rendered from an agent's own `options.fallback.message.text`, which sits in
clear in the database. Encrypting a rendering of plaintext we already hold
buys no confidentiality.

More importantly it would cost CPU in the worst possible place. This path runs
when an agent session has failed, and one of the likelier reasons for that is
that the system is under load — so the playout path is disproportionately
likely to execute exactly when there are no cycles to spare. It must be as
cheap as we can make it. That is the same reasoning behind storing PCM rather
than a compressed codec: playing a cached announcement should be a download, a
resample, and a write to the transport, with no decrypt and no decode in the
way.

The bucket is platform-private and is never exposed to tenants.

## Audio format

- Container: **WAV** (RIFF/WAVE), codec **PCM**, signed 16-bit little-endian.
- Channels: **mono**.
- Sample rate: **whatever the synthesising TTS emitted** — readers must take
  the rate from the WAV header and resample to their transport's rate. It is
  deliberately not pinned: the two runtimes synthesise through different vendor
  stacks, and forcing a rate would mean an extra resample on the write path for
  no benefit.

WAV rather than raw PCM so the rate travels with the samples, and so a cached
object can be pulled from the bucket and played in any audio tool during
diagnosis.

Readers must walk the RIFF chunks rather than assuming `data` at offset 36:
some vendors emit a `LIST` or `fact` chunk first, and a fixed-offset reader
turns such a payload into noise.

## Write concurrency

Uploads use `ifGenerationMatch: 0` (create-only). When an outage fails many
calls at once, every worker misses and synthesises concurrently; the first to
finish publishes and the rest receive a precondition failure, which both
implementations report to their caller as success — the cache does now hold the
object. The losers play the copy they synthesised for their own call.

## Failure behaviour

Every cache operation is never-throw in both implementations. A read failure is
a miss (synthesise it again this call); a write failure is a no-op (re-synthesise
next time). This path only ever runs when something else has already broken, so
it must not add a second failure of its own.
