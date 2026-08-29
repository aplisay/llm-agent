# Credentials at rest: audit and migration sweep

Credential values (SIP registration passwords, recording keys, call encryption
keys) are encrypted at rest with AES-256-GCM under a key derived from the
`CREDENTIALS_KEY` environment variable (`lib/utils/credentials.js`). Every
encrypted value has the form:

```
enc:<base64 12-byte iv>:<base64 16-byte tag>:<base64 ciphertext>
```

Instances deployed **without** a `CREDENTIALS_KEY` stored these values as raw
plaintext (the write path failed open). The read path tolerates that — any
stored value without the `enc:` prefix is passed through unchanged — so setting
a key on a legacy instance is safe and backward compatible, but rows written
before the key existed stay plaintext until rewritten. `tools/credentials-audit.js`
(backed by `lib/utils/credentials-sweep.js`) closes that gap: run it by hand,
against a chosen database, on your own schedule — nothing runs this
automatically at boot.

## Where credentials live

| Location | Storage |
| --- | --- |
| `phone_registrations.password` | text column |
| `calls.encryption_key` | varchar column |
| `agents.options.recording.key` | string nested in JSONB |
| `instances.recording.key` | string nested in JSONB |

(Organisation BYOK provider keys — `organisation_keys.value` — are fail-closed
from birth and never have plaintext rows, so they are not part of this sweep.)

## Classification

`classifyStoredSecret()` distinguishes, per stored value:

- **plaintext** — no `enc:` prefix: a legacy value. The sweep encrypts these.
- **encrypted** — structurally valid and the GCM auth tag verifies under the
  current key. Because GCM is authenticated, this is cryptographic proof the
  value was written under this key, not a heuristic.
- **encrypted-foreign** — structurally valid but the tag fails: written under
  a *different* key, or corrupted. Never touched; investigate (usually the
  instance once ran with another key).
- **enc-lookalike** — `enc:`-prefixed but structurally invalid (wrong part
  count, iv ≠ 12 bytes, tag ≠ 16 bytes). In reality plaintext that happens to
  start with `enc:`; today's read path returns null for these. Surfaced by the
  audit, never modified by the sweep.
- **encrypted-unverified** — structurally valid, but no `CREDENTIALS_KEY` in
  this process to verify the tag against (keyless audit only).

## CLI: audit and sweep a database directly

`tools/credentials-audit.js` connects with the `POSTGRES_*` environment only —
no schema sync, no listener, nothing written in audit mode — so it can be run
against a live legacy instance before or after any deploy, pointed at whichever
`.env` you choose:

```
node tools/credentials-audit.js [--path <envfile>] [--json]   # read-only audit
node tools/credentials-audit.js --sweep [--path <envfile>]    # encrypt plaintext, then re-audit
```

`--path`/`-p` loads that env file (via `dotenv`) before connecting, so a single
checkout can target any instance's database by pointing at its `.env`.
`--sweep` refuses to run without `CREDENTIALS_KEY` present (in the environment
or the loaded file).

Sweep behaviour: any definitely-plaintext value (`NOT LIKE 'enc:%'`, and for
JSONB locations only JSON strings) is encrypted in place, row by row, with an
optimistic `AND value = original` guard so a concurrent writer wins and the
row is simply picked up on the next sweep. `updated_at` is not bumped and
values are never logged. Idempotent by construction: a second run matches
nothing. The readable value is identical before and after (plaintext
passthrough vs decrypt); only the at-rest form changes.

Exit codes: `0` every stored credential verified encrypted under the current
key; `1` findings (plaintext / lookalike / foreign / unverified, or a location
that errored); `2` usage or connection error. Row ids are reported for
anomalous classes; credential values are never printed.

## Migrating a legacy instance

1. **Audit first**, without a key: expect `plaintext` counts and nothing
   `encrypted` (a legacy instance never encrypted anything). Anything
   `encrypted-unverified` means the instance was not keyless all along — stop
   and work out which key wrote it.
2. **Back up the database, then mint and set `CREDENTIALS_KEY`** in the
   instance's secret store. Key custody is the critical step: once swept,
   values are unrecoverable without the key (the plaintext state, ironically,
   is the recoverable one). The key must never change afterwards — a changed
   key turns every stored credential into `encrypted-foreign` (reads return
   null).
3. **Run the tool with `--sweep`** against that instance's database (e.g.
   `node tools/credentials-audit.js --path .env.staging --sweep`). Nothing
   encrypts automatically — this is the step that does it. Reads keep working
   with a plaintext row either way, so there is no urgency beyond your own
   change window.
4. **Re-audit**: expect only `encrypted`. Exit code 0 is the fleet-scriptable
   signal.
5. Old database backups still contain plaintext — rotate them on the normal
   retention schedule as part of the remediation.
