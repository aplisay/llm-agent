# Billing Rate Cards — Implementation Status / Handoff

**Design doc (the spec):** [`rate-cards-implementation-plan.md`](./rate-cards-implementation-plan.md).
**Branches:** `billing` in **both** repos — llm-agent (`/Users/rob/Aplisay/code/llm-agent`) and the eval
harness test-agent (`/Users/rob/test-agent`, branched off `agent-set-experiment`).

## TL;DR

**Phase 0 (schema) + Phase 1 (capture, + 2026-06-30 hardening) + Phase 2 (costing engine)** are
**code-complete and unit-verified**. Phase 1: every priced component (voice/audio-path, LLM tokens, TTS
chars+ms, STT chars+ms) is metered with the **real vendor**, the **media** (webrtc/telephony), and a
**billedAt** anchor, across llm-agent + the LiveKit and Pipecat workers, plus an eval harness that asserts it
on real calls. Phase 2: `lib/rates.js` values each finalised row against the org's effective `RateCard`
(additive-by-dimension, frozen cost-at-write) and settles `Organisation.balance`, wired into the meter choke
points (inert until Phase 3 assigns rates). **Phases 3–5 remain** (admin API/RBAC, polite-ai UI, deferred).

**⚠️ BEFORE CAPTURE WORKS AGAINST ANY DB: run the migration (now schemaVersion 45).** The model references
columns an un-migrated DB lacks (`billed_at`, `media`, `cost_micros`, …); on such a DB every full-model
`UsageRecord` read/write throws `column "billed_at" does not exist` → zero usage rows. Fix: boot llm-agent
once with `DB_FORCE_SYNC=true` (or in `NODE_ENV=development`, which forces sync; the `tests-postgres-test-1`
container also auto-migrates). The `RateCard` EXCLUDE-gist constraint needs `btree_gist` — the Cloud SQL
`postgres` role can `CREATE EXTENSION` it; if a role can't, it logs+skips and the `usage_records` columns
still land, so billing works.

**Why 45, not 44 — the partial-44 trap (resolved 2026-06-29).** The dev DB `llmvoicedev` reached
`dbVersion=44` from an *intermediate* `database.js` whose model had only the `organisations.*` billing
columns; the `usage_records` billing columns and the `rate_cards` table were added to the model *later under
the same version number*. With `44===44` the gate `schemaVersion > dbVersion` was false, so even
`DB_FORCE_SYNC=true` skipped the alter-sync — boot logged `version mismatch, wont upgrade` while serving
against the half-migrated table. Fix: bumped `schemaVersion` 44→45 (idempotent on DBs already fully on v44).
A forced re-sync then added the 8 usage cols + 2 indexes, created `rate_cards`, installed `btree_gist`, and
added the EXCLUDE constraint; a full model-vs-DB drift audit came back clean. **Lesson: bump `schemaVersion`
on EVERY schema change** — adding columns under an unchanged number strands them on any DB already at that
version. **Staging/prod likely have the same partial-44 state** — the 44→45 bump heals them on next deploy
booted with `DB_FORCE_SYNC=true`.

## Done — commits

### llm-agent `billing`
| commit | what |
|---|---|
| `a929a07` | **Phase 0** schema v44: `RateCard` table (+ EXCLUDE-gist non-overlap, raw DDL), `Organisation.{rateHistory,balance,billingConfig,billingBlocked}`, `usage_records.{billedAt,media,costMicros,appliedCostMicros,currency,rateName,rateCardStart,costStatus}` + indexes; schemaVersion 43→44 |
| `f51b935` | **1a** media-at-write: `Call.mediaFromIds` + `media` on the voice row; Jambonz `platform:'jambonz'` fix |
| `c9e586c` | **1b** text: `finaliseSession()` in lib/usage.js + `metadata.startedAt` anchor + ws-close finalise in lib/text-chat.js |
| `7305a7f` | **Pipecat** vendor normalisation (`usage_vendors`) + STT chars+ms + TTS ms (usage.py); consult already metered |
| `bbfc2f0` | **LiveKit 1c a/b** canonical vendor (`lib/usage-vendors.ts` `resolveUsageVendors`) in `addMeter`; STT chars via `UserInputTranscribed` |
| `f3a00f9` | `/api/usage?callId=` per-call filter + `call` groupBy dimension |
| `1450e35` | **LiveKit 1c d** consult-leg metering: `lib/usage-meter.ts` `makeUsageMeter` + transfer-handler wires a consult-scoped meter (WeakMap, flush on consult end) |
| `fa4eed7`,`fc77bd2` | `Call.end()` robustness: **two-phase** — complete+save the call record (release concurrency), THEN best-effort isolated usage/billing, so a metering/schema error can never leave an incomplete record. (`9e34d53` was a wrong start/end race fix — REVERTED by `fc77bd2`.) |

### test-agent `billing` (eval harness)
| commit | what |
|---|---|
| `f59702b` | `verify/usageLedger.ts` (`assessCallUsage`/`verifyCallUsage`) + `client.getCallUsage` + `UsageRow`; wired non-fatal into `weatherPair` |
| `eb0df67` | usage assertions on `weatherWebrtc` (target call) + `consultWebrtc` (consult call) |
| `0158280` | log fetched usage rows (`"usage ledger: N row(s)…"`) + explicit skip messages |
| `145e4dd` | poll-for-finalised + `settleRetries` (usage flushes a beat after call end) |
| `c712168` | resolve the consult call without `--record` (finalised child of primary under the B agent) |
| `607b31d` | `EVAL_WEBRTC_TARGET_MODEL` env override (default WebRTC targets are all Ultravox) |

## How to run / verify

- **llm-agent DB tests** (need the `tests-postgres-test-1` container; PG15 :5433, db `llmvoicetest`/`testuser`; it auto-syncs v44):
  `LOGLEVEL=fatal node --experimental-vm-modules node_modules/.bin/jest --config jest.config.db.js --coverage=false <file>`
  — usage-call-minutes, usage-model, usage-api, agent-db-usage, rate-card-model, **rates** →
  **51 green** (run the DB set with `--runInBand`: the suites share one PG connection and flake on parallel
  teardown). `tests/rates.test.mjs` (21) covers the Phase-2 resolver/settle/costUsageRow/sweep + immutability.
- **Pipecat:** `cd agents/pipecat && uv run pytest` → **95 green** (incl. `tests/test_usage.py`).
- **LiveKit:** `cd agents/livekit && node --import tsx --test test/usage-vendors.test.ts test/usage-meter.test.ts` → **9 green**; `npx tsup --clean` builds.
- **test-agent:** `cd /Users/rob/test-agent && npx vitest run src/eval/verify/usageLedger.test.ts` → **4 green**.

## Phase 1 hardening — capture bugs found via live eval + DB inspection (2026-06-30)

Testing 1c/d through the eval surfaced **wrong Ultravox usage rows** (a `stt/deepgram/characters` row on
Ultravox legs; the eval only saw one of three consult legs). DB inspection of two real calls confirmed the
diagnosis and these fixes landed (all unit-verified; the LiveKit `dist` was rebuilt with A+C):

| # | bug | fix | files |
|---|---|---|---|
| **A** | `UserInputTranscribed` fired for **realtime** (Ultravox/gpt-realtime) agents too and tagged transcript chars with the *pipeline-default* STT vendor (`deepgram/nova-3`) → phantom `stt` row that double-charges. Realtime bundles STT+TTS into the model charge. | Single guard in `addMeter`: `voiceMode==='realtime'` ⇒ drop `stt`/`tts` (llm tokens still flow for gpt-realtime). Consult meter gained a `voiceMode` opt wired from `resolveVoiceMode`. | `voice-agent-runtime.ts`, `usage-meter.ts`, `transfer-handler.ts` |
| **B** | The `telephony:bridged-call` tail leg inherited `WebRTC` caller/called ids → `media` mis-derived `webrtc`; it wouldn't match the telephony bridged-call rate line. | `recordUsageMinutes` pins `media='telephony'` for the sentinel (covers LiveKit **and** Pipecat bridge paths). | `lib/database.js` |
| **C** | After a blind bridge, `getActiveCall()` flips to the **no-agent bridged record**, so the agent session's component meters (the stray stt; llm/tts in a pipeline transfer) flushed onto the bridge. | Added `getAgentCall` (= `activeAgentCall`, no bridge override); `flushUsage` targets it. | `worker.ts`, `types.ts`, `voice-agent-runtime.ts` |
| **D** | The prod Ultravox webhook (`callEnded`) set timing+usage but never marked the call `live=false`/`status` nor released the `Call.start()` concurrency reservation (a prod slot **leak**); not idempotent. | `callEnded` bails if `!call.live`, else delegates to the canonical `Call.end()` (now takes an optional authoritative `endedAt`). Pure tidying — **not** an eval gate. | `lib/handlers/ultravox.js`, `lib/database.js` |
| **E** | The consult eval asserted only the consult leg, so all 3 legs *looked* missing when they were metered. | `verifyCallLineageUsage` + `getLinkedCalls` (`GET /calls/{id}/linked` — durable `parentId` tree; survives the **null `agentId`** on worker legs). Asserts each leg has its voice row and realtime/bridged legs carry no stt/tts. | test-agent `usageLedger.ts`, `client.ts`, `consultWebrtc.ts` |

The voice row already carried the Ultravox model in `detail` and the transport in `media` (one voice row,
two dimensions, per §2) — the "missing ultravox model" was an eval **display** gap, not a capture gap.
**Phase-2 carry-over:** the §3.1 example matches the **model** dimension on `provider:'ultravox'`, but a
realtime voice row's provider is the *handler* (`livekit`); the resolver must match the model dimension on
`detail`/modelName, not provider. Fix the example when building `lib/rates.js`.

## Live validation status (eval)

The eval asserts per-call usage **non-fatally** (`usage.present`, `usage.providerLabelled` = non-null & not
`inference`, `usage.has.voice`, and — per leg via `verifyCallLineageUsage` — `usage.noComponentRows` on
realtime/bridged legs) on `weatherPair`, `weatherWebrtc`, `consultWebrtc`. Grep the eval output for
`usage ledger:` / `usage lineage leg`.

**OPEN ITEM — can't validate pipeline capture via the eval yet.** All default WebRTC targets run **Ultravox**
(`*:ultravox/ultravox-v0.6`), a managed bundle with no separate vendors and no token metrics → nothing for
the vendor-normalisation to act on. `EVAL_WEBRTC_TARGET_MODEL=livekit:openai/gpt-4o` overrides the model, but
the weather agent body pins `tts.vendor=ultravox, voice=Ciara`, so a pipeline model 400s
(`"Voice Ciara not supported by livekit:openai/gpt-4o"`). **To validate the pipeline path** you need a
pipeline-compatible agent body (e.g. `tts.vendor=cartesia`+a cartesia voice, deepgram STT) — either a new
sample-agent or an env/flag to swap the tts/stt block alongside the model. Once a pipeline call runs against
a migrated DB, the `usage ledger:` line should show `voice/llm/tts/stt` rows with **real vendors**
(`openai`/`cartesia`/`deepgram`) = R3 working.

## Phase 2 — costing engine: DONE + unit-verified (2026-06-30, `billing`)

New **`lib/rates.js`** (cost-at-write / frozen); 21 tests in `tests/rates.test.mjs` (run serially —
`--runInBand`; the DB suites share one PG connection so parallel runs flake on teardown):
- **`resolveRowCost`** — additive-by-dimension resolver: most-specific matching line WITHIN each dim
  (`audio-path | model | tts | stt`), SUM across. One minute-billed realtime `voice/ms` row prices on BOTH
  audio-path (handler+media) and model (the model id in `detail`). **The model dimension matches on `detail`,
  NOT `provider`** (a realtime voice row's provider is the handler, `livekit`) — corrects the §3.1 example.
- **`toLineUnits`** (ms/seconds→minute; tokens/chars 1:1), **`resolveOrgRateName`** / **`resolveRateCard`** /
  **`resolveBilledAt`** (two-level temporal: `org.rateHistory@billedAt` → `RateCard` effective@billedAt).
- **`settle`** — atomic `balance -= (costMicros − appliedCostMicros)`, then `appliedCostMicros = costMicros`
  (idempotent + convergent: reflush / sweep / re-cost never double-apply; null balance = untracked, skipped).
- **`costUsageRow`** — never-throw orchestrator: stamps `billedAt`/`costMicros`/`currency`/`rateName`/
  `rateCardStart`/`costStatus` (`matched`/`no_rate`/`no_line`/`errored`) + per-line breakdown in `metadata`;
  settles. A resolver throw → `costStatus='errored'`, quantity untouched.
- **Trigger wiring** (cost-at-finalisation, isolated from the meter write): `lib/usage.js` `recordUsage`
  (finalised rows) + `finaliseSession` (session-end); `lib/database.js` `recordUsageMinutes` at `Call.end()`
  (lazy `import('./rates.js')` avoids a module cycle). Inert until Phase 3 assigns rates (`no_rate`).
- **Immutability guard** — `RateCard` `beforeUpdate` rejects pricing edits once a usage row references it
  (supersede via a new later-`startDate` card); cosmetic edits free.
- **`sweepUncostedRows`** — reconciliation: costs finalised rows that are uncosted / `no_rate` / `errored`
  (backfill + retry + re-cost-on-correction); frozen `matched` rows untouched. **Nightly trigger
  (scheduler → admin endpoint) lands in Phase 3.**

## What remains (next phases — see the plan for full detail)

- **Phase 3 — admin API + RBAC**: `rate` permission resource + `organisation:setRate`; `/api/rates` CRUD;
  `/api/rate-components` (env-independent atomic catalogue); `/api/organisations/{id}/{rate-history,balance,balance/credit}`;
  add `cost` to `/api/usage`.
- **Phase 4 — polite-ai** (`/Users/rob/Aplisay/code/polite-ai`): `dashboard.rates.tsx` (component-grid editor
  driven by `/api/rate-components`); retire the flat `RATE_CARD`; `Organisation.balance` becomes the
  spendable-funds SoT, Stripe top-up webhook credits it.
- **Phase 5 — deferred**: balance callbacks (`balanceLow`/`balanceNegative`, model on `lib/call-hook.js`);
  hot-path refusal (`billingBlocked` enforced in `Call.start()`); agentless passthrough product; per-user
  rate override (resolver checks `User.rateHistory` first).

## Key decisions (don't re-derive — full rationale in the plan)

- Costing lives in **llm-agent** (hot path, **cost-at-write**/frozen). polite-ai = async Stripe consumer.
  `Organisation.balance` (micro-pence, nullable) = single SoT for spendable funds; decremented per costed row.
- **Additive-by-dimension** resolver. The **model** dimension is **per-model** (gpt-realtime = per-token,
  Ultravox = per-minute, a future model may have both). **TTS/STT** priceable by **characters OR time, per
  engine**. Vendor **normalised at the producer boundary**. `media` from `callerId/calledId` (`'WebRTC'` vs
  E.164). `billedAt` = interaction start. Cards **immutable once referenced** (supersede via new `startDate`).

## Working-tree note

llm-agent `billing` has **unrelated** uncommitted changes (`agents/.../confidence-tone.*`,
`docs/call-transfers.md`) that are NOT part of the billing work — leave them.
