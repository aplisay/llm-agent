# Billing Rate Cards — Implementation Status / Handoff

**Design doc (the spec):** [`rate-cards-implementation-plan.md`](./rate-cards-implementation-plan.md).
**Branches:** `billing` in **both** repos — llm-agent (`/Users/rob/Aplisay/code/llm-agent`) and the eval
harness test-agent (`/Users/rob/test-agent`, branched off `agent-set-experiment`).

## TL;DR

**Phase 0 (schema) + Phase 1 (capture)** are **code-complete and unit-verified**. Phase 1 means: every
priced component (voice/audio-path, LLM tokens, TTS chars+ms, STT chars+ms) is metered with the **real
vendor**, the **media** (webrtc/telephony), and a **billedAt** anchor, across llm-agent + the LiveKit and
Pipecat workers, plus an eval harness that asserts it on real calls. **Phases 2–5 remain** (costing engine,
admin API/RBAC, polite-ai UI, deferred items).

**⚠️ BEFORE CAPTURE WORKS AGAINST ANY DB: run the v44 migration.** The v44 *model* references columns the
un-migrated DB lacks (`billed_at`, `media`, `cost_micros`, …). On a v43 DB every full-model `UsageRecord`
read/write throws `column "billed_at" does not exist` → zero usage rows. Fix: boot llm-agent once with
`DB_FORCE_SYNC=true` (the `tests-postgres-test-1` container already auto-migrates). The `RateCard`
EXCLUDE-gist constraint needs `btree_gist`; if the DB role can't `CREATE EXTENSION` it logs+skips — the
`usage_records` columns still get added, so billing works.

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
  — usage-call-minutes, usage-model, usage-api, agent-db-usage, rate-card-model → **27 green**.
- **Pipecat:** `cd agents/pipecat && uv run pytest` → **95 green** (incl. `tests/test_usage.py`).
- **LiveKit:** `cd agents/livekit && node --import tsx --test test/usage-vendors.test.ts test/usage-meter.test.ts` → **9 green**; `npx tsup --clean` builds.
- **test-agent:** `cd /Users/rob/test-agent && npx vitest run src/eval/verify/usageLedger.test.ts` → **4 green**.

## Live validation status (eval)

The eval asserts per-call usage **non-fatally** (`usage.present`, `usage.providerLabelled` = non-null & not
`inference`, `usage.has.voice`) on `weatherPair`, `weatherWebrtc`, `consultWebrtc`. Grep the eval output for
`usage ledger:`.

**OPEN ITEM — can't validate pipeline capture via the eval yet.** All default WebRTC targets run **Ultravox**
(`*:ultravox/ultravox-v0.6`), a managed bundle with no separate vendors and no token metrics → nothing for
the vendor-normalisation to act on. `EVAL_WEBRTC_TARGET_MODEL=livekit:openai/gpt-4o` overrides the model, but
the weather agent body pins `tts.vendor=ultravox, voice=Ciara`, so a pipeline model 400s
(`"Voice Ciara not supported by livekit:openai/gpt-4o"`). **To validate the pipeline path** you need a
pipeline-compatible agent body (e.g. `tts.vendor=cartesia`+a cartesia voice, deepgram STT) — either a new
sample-agent or an env/flag to swap the tts/stt block alongside the model. Once a pipeline call runs against
a migrated DB, the `usage ledger:` line should show `voice/llm/tts/stt` rows with **real vendors**
(`openai`/`cartesia`/`deepgram`) = R3 working.

## What remains (next phases — see the plan for full detail)

- **Phase 2 — costing engine** (llm-agent, new `lib/rates.js`): additive-by-dimension resolver
  (audio-path | model | tts | stt; most-specific line WITHIN each dimension; SUM across), `billedAt`
  resolution, two-level temporal lookup (`org.rateHistory` → `RateCard` effective@billedAt), `settle()`
  (atomic delta-decrement of `Organisation.balance` via `appliedCostMicros`), never-throw
  cost-at-finalisation hooked in `lib/usage.js` + a nightly reconciliation sweep. **Fully unit-testable.**
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
