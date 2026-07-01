# Usage Billing — Rate Cards, Cost-at-Transaction-End & Org Balance

**Status:** design hardened (79-agent adversarial review, 57 confirmed issues all folded in); all owner
decisions + detail questions resolved (§1, §10); **awaiting owner review of this spec** before
implementation on a `next`-derived worktree/branch.
**Repos:** `llm-agent` = commercial, front-end-agnostic **hot path** (owns rates, costing, balance).
`polite-ai` = React-Router-7 BFF, **async consumer** (owns Stripe; UI). `llm-frontend` = legacy, superseded.

---

## 1. Decisions of record

| # | Decision |
|---|---|
| D1 | Costing in **llm-agent**, **cost-at-write**: a frozen cost is stamped on each usage row at transaction end; later rate edits never move historical cost. |
| D2 | **Single canonical rate card** is THE valuation source; the flat `RATE_CARD` in polite-ai is retired; subscription PLANS become *packaging* (included allowance + which rate-name an org is on). |
| D3 | **Media** (webrtc/telephony) is a first-class pricing dimension; **per-leg** pricing from day one. |
| D4 | **STT metered** as a priced component (LiveKit already ships it; Pipecat needs a new source). |
| D5 | **Separation:** `Organisation.balance` (llm-agent, nullable micro-pence) is the **single SoT for spendable funds**. `null`=untracked; numeric=running balance decremented per costed row. Built so hot-path refusal is *possible* later but **not implemented now**. Frontend polls balance + does Stripe top-ups (top-up **credits** llm-agent; llm-agent never calls Stripe). Async `balanceLow`/`balanceNegative` org callbacks are **designed now, built later**. |
| R1 | **Additive, itemised by dimension** resolver (resolves the brief's two-per-minute requirement). |
| R2 | **Charge every connected leg** its own audio-path minutes by its own media (incl. concurrent consult legs and bridged tail-legs). |
| R3 | **Normalise vendor/model vocabulary at the producer boundary** (rows become self-describing). |
| R4 | **llm-agent `Organisation.balance` canonical**; polite-ai `billing_accounts`/`ledger_entries` demoted to Stripe-side bookkeeping; Stripe top-up webhook calls an idempotent llm-agent credit endpoint. |

---

## 2. The charge model (R1 — the keystone)

A priced interaction is the **SUM of independent per-dimension charges**. Dimensions are orthogonal:

| dimension | what it prices | meter row it reads | billing unit |
|---|---|---|---|
| `audio-path` | transport: handler × media | `voice`/`milliseconds` (one per leg) | per **minute** |
| `model` | the agent model | realtime: the `voice` row (per **minute**); pipeline LLM: `llm`/`*_tokens` rows (per **token**) | minute or token |
| `tts` | TTS vendor | `tts`/`characters` | per **character** |
| `stt` | STT vendor | `stt`/`milliseconds` | per **minute** |

**Resolver:** for each usage row, for **each dimension**, find the **most-specific matching line**; the
row's cost = **Σ over dimensions** (matched line price × quantity converted to the line's unit). A call's
total = Σ of its rows' costs (incl. all legs). Key consequences:

- **The `model` dimension is per-model, NOT per-class.** A model's model-charge follows the vendor's
  actual billing basis, independent of the audio path:
  - **pipeline LLM** → per-token, on its `llm/*_tokens` rows;
  - **token-billed realtime** (e.g. `gpt-realtime`) → per-token, on its `llm/*_tokens` rows; its
    `voice/ms` row gets **only** audio-path (no model-minute line);
  - **minute-billed realtime** (e.g. Ultravox) → per-minute, on its `voice/ms` row; it emits no tokens;
  - **future realtime billed on BOTH** → a per-token line (token rows) **and** a per-minute line (voice
    row) are both allowed — the resolver already supports it (they match different rows). The schema/UI
    must not preclude it.
- **`audio-path` is always a separate dimension** (handler×media minutes from the transport leg) applied
  on top regardless of how the model is billed: `gpt-realtime` over telephony = token model charge +
  telephony audio-path minutes; Ultravox over telephony = minute model charge + telephony audio-path
  minutes. A **pipeline** call = audio-path + llm-tokens + tts-chars + stt-minutes — itemised transport
  vs model/vendor cost, not wall-clock double-count.
- **No SAME-METER double-charge (the real guardrail).** A `beforeSave` validator forbids pricing the
  *same engine's same output* under two units — LiveKit emits both `tts/characters` and `tts/milliseconds`
  for one synthesis, so a given TTS engine is priced on **exactly one** unit — and rejects two
  equally-specific matchable lines in the same dimension (deterministic tie). **But the CHOICE of unit is
  per-engine and free:** TTS/STT may be priced by **characters OR time**, independently per engine, and two
  engines on the same handler may differ (ElevenLabs by characters, Cartesia by minutes). It does **NOT**
  restrict a model to one metric either: token+minute on one model is legal when the vendor bills both.
  `media` is a legal match key **only** when `technology='voice'`.
- **Wildcard = key omission** (a line matches iff every *specified* key equals the row's field); the UI
  offers an explicit "broad line" affordance and a default/fallback line per dimension.

The **catalogue (`/api/rate-components`) advertises, per model, the metric(s) the vendor actually bills
on** (token and/or minute), sourced from each model's real pricing basis — pipeline LLM ⇒ tokens;
`gpt-realtime` ⇒ tokens; Ultravox ⇒ minutes; a both-billed model ⇒ tokens **and** minutes — plus TTS ⇒
char, STT ⇒ minute, audio-path ⇒ minute by handler×media. The UI **guides** (prompts the advertised
metric(s) and pre-creates those lines) but does **not hard-block** other combinations; only the
same-meter double-charge guardrail above is enforced. (Q-A resolved — see §10.)

---

## 3. Data model (llm-agent, schemaVersion 43 → 44)

### 3.1 `RateCard` table (new)
`id` BIGINT PK · `name` STRING · `startDate` **timestamptz** · `endDate` **timestamptz null** ·
`currency` STRING `'gbp'` · `detail` JSONB · `description` · `createdBy` · timestamps.
- **Effectivity:** stored `endDate` is the **single authority** (no next-start derivation). Effective at
  `ts` iff `startDate ≤ ts < endDate` (null endDate = open). 
- **Non-overlap** per name enforced by a Postgres `EXCLUDE USING gist (name WITH =, tstzrange(startDate,endDate) WITH &&)`
  added via **raw idempotent DDL** (Sequelize `sync` won't emit it).
- `detail` JSONB:
```jsonc
{ "lines": [
  { "dim":"audio-path", "match":{"technology":"voice","provider":"livekit","media":"webrtc"},   "unit":"minute", "priceMicros": 500000 },
  { "dim":"audio-path", "match":{"technology":"voice","provider":"livekit","media":"telephony"},"unit":"minute", "priceMicros": 1000000 },
  { "dim":"audio-path", "match":{"technology":"voice","detail":"telephony:bridged-call","media":"telephony"}, "unit":"minute", "priceMicros": 1000000 },
  { "dim":"model",      "match":{"technology":"voice","provider":"ultravox"},                    "unit":"minute", "priceMicros": 6000000 },   // minute-billed realtime (no tokens)
  { "dim":"model",      "match":{"technology":"llm","provider":"openai","detail":"gpt-realtime","unit":"output_tokens"},      "unit":"token", "priceMicros": 8000 },   // token-billed realtime (audio-path billed separately)
  { "dim":"model",      "match":{"technology":"llm","provider":"anthropic","detail":"claude-opus-4-8","unit":"output_tokens"}, "unit":"token", "priceMicros": 4000 },   // pipeline LLM
  { "dim":"tts",        "match":{"technology":"tts","provider":"elevenlabs","unit":"characters"},"unit":"character", "priceMicros": 100 },
  { "dim":"stt",        "match":{"technology":"stt","provider":"deepgram","unit":"milliseconds"},"unit":"minute", "priceMicros": 500000 }
]}
```
`priceMicros` = micro-pence (1e-6 GBP penny) per the line's `unit`; resolver converts the row quantity
(its meter unit) to the line unit.

### 3.2 `Organisation` (new columns)
- `rateHistory` JSONB `[{name, startDate}]` — validated on write (sorted, no dup startDates, each name
  has a covering card); resolution = entry with greatest `startDate ≤ ts`.
- `balance` BIGINT **null** — micro-pence; null = untracked.
- `billingConfig` JSONB — thresholds + callback URLs (**design-only** in v1).
- `billingBlocked` BOOLEAN default false — purpose-named hard lever enforced in `Call.start()`
  (the "max-instances=0" lever the callbacks assumed **does not exist**); **design-only / not enforced in v1**.

### 3.3 `usage_records` (new columns)
- `billedAt` **timestamptz** — the canonical billing instant (= interaction start; see §4); rates resolve
  **and** `/usage` period-buckets on this, not `created_at` (which stays immutable audit).
- `media` STRING null — webrtc/telephony, **persisted at write** from the leg's OWN egress.
- `costMicros` BIGINT null · `appliedCostMicros` BIGINT default 0 · `currency` · `rateName` · `rateCardStart`.
- `costStatus` — free-form **STRING** (values `matched` / `no_line` / `errored` / `no_rate`; replaces a
  single null+flag). STRING not a DB enum, deliberately matching the existing `technology`/`unit`
  no-migration convention so new states need no schema change.

---

## 4. Costing & balance (llm-agent — `lib/rates.js` + `lib/usage.js`)

**`billedAt`** = `Call.startedAt` (via `callId`) for voice/worker rows, falling back
`Call.startedAt → Call.createdAt → row.created_at` (never dereference null `startedAt`). For text it is
the session-start anchor (§5.5). The whole session pins to one rate-name resolved at `billedAt`.

**`costUsageRow(row)`** (idempotent, never-throw):
1. resolve `billedAt`; resolve org rate-name from `rateHistory@billedAt`; resolve `RateCard` effective@billedAt.
2. additive resolve (§2) → `costMicros` + per-line breakdown (stamped in `metadata` for `/usage` itemisation).
3. set `costStatus`; on resolver throw → `costStatus='errored'`, `costMicros=null`, **commit the quantity
   regardless** (cost is isolated from the meter write transaction so a billing miss never becomes a
   metering miss — preserves lib/usage.js "recording must never throw").
4. **`settle()`**: in ONE atomic statement (house atomic-`increment` pattern, not read-then-save)
   `balance -= (costMicros - appliedCostMicros)`; then `appliedCostMicros = costMicros`. Convergent, so
   reflush / per-row finalisation / nightly sweep all share it without double-applying. Skip if `balance` null.

**Triggers:** route `Call.recordUsageMinutes` (voice + Ultravox bypass) through the one choke point and
gate the in-transaction stamp on `finalised===true`; worker `mode:'set'` finalised flushes cost on
arrival; the **nightly sweep** costs any `costStatus IN (no_rate, errored)` OR `costMicros IS NULL` row —
which **doubles as the historical backfill** and the re-cost-on-correction tool. `balance` is
go-live-forward, not lifetime.

**Frozen-cost correction invariant:** `RateCard.detail` is **immutable once referenced** — a price change
is a new card with a later `startDate` (supersede), enforced by a `beforeUpdate` guard. (Avoids silently
re-pricing stamped history.)

---

## 5. Capture changes (Phase 1)

### 5.1 Vendor normalisation at the producer boundary (R3)
LiveKit `addMeter` and Pipecat `usage.py` emit a **canonical `{provider=vendor, detail=modelId}`** derived
from the *configured service* — for LiveKit-**Inference** (today `provider='inference'`, vendor-blind)
derive the real vendor from agent config, not the SDK label. `/api/rate-components` is the canonical
vocabulary; a **CI assertion** verifies the same agent across LiveKit-Inference / LiveKit-keys / Pipecat
resolves to the same rate line. `detail` becomes optional in match keys (provider+technology+unit are the
stable spine).

### 5.2 Media at write, per leg (R2 / D3)
Persist `media` on each leg's voice row from that leg's **own egress** (not inherited A-leg `callerId`):
- WebRTC-origin bridged/transfer **children** carry the *onward* media (LiveKit is the broken path that
  currently inherits `'WebRTC'`); the agent-transfer **continuation** stays `webrtc`.
- Backfill `platform:'jambonz'` at Jambonz inbound `Call.create` (today null → unmatchable telephony).
- Pipecat blind-bridge legs must carry the `telephony:bridged-call` sentinel (not the agent modelName).

### 5.3 Per-leg & consult (R2 / Q-B)
Each leg = its own `Call` row (`parentId` lineage) → its own `voice` row → charged independently. The
**concurrent consult leg is a full agent leg** and is billed as such — both concurrent legs' audio-path
minutes are charged. The **LiveKit consult LLM/STT/TTS metering gap is closed in v1** (Q-B) so the
consult leg is fully itemised like any agent leg (Pipecat already meters its consult leg).

### 5.4 TTS & STT billing-basis completeness (D4 + per-engine choice)
Rate lines can price TTS/STT by **either characters OR time, chosen per engine** (§2), so each engine must
**meter** every basis it might be priced on. Targets:
- **TTS characters** — already metered on both stacks. **TTS time (ms)** — LiveKit already emits it; add
  audio-duration metering to **Pipecat** where the SDK exposes it.
- **STT time (ms)** — LiveKit already ships (`voice-agent-runtime.ts`); **Pipecat** builds it from a
  VAD/STT-service event source (no `STTUsageMetricsData` exists), provider normalised to match LiveKit.
  **STT characters** — not metered today; **derive from the final transcript length** on both stacks where
  the result exposes it.
Emit **both** bases when the engine/SDK exposes them; `/api/rate-components` advertises, **per engine**,
which units are actually available, so the admin is only ever offered a basis that has a live meter, and a
rate line is gated to handlers that emit its unit.

### 5.5 Text-session finalisation (blocker)
Interactive text-chat (`lib/text-chat.js`) writes `increment` rows never finalised. Add **per-turn
delta-cost** (compose with the `settle()` primitive) so cost survives dropped sockets / process death,
**plus** a session-end finalisation on `ws.close` and `PENDING_TTL` expiry, with the nightly sweep as
backstop. Headless `/invoke` already finalises (don't add a redundant hook); agent-db subagent rides the
parent `callId`. The single increment row per `(sessionId,meterKey)` pins the whole text session to one rate.

---

## 6. Balance, top-up & callbacks (R4 / D5)

- `Organisation.balance` (llm-agent) is the **only spendable-funds SoT**; one-time migration seeds it from
  current `billing_accounts.balance_pennies`.
- **Top-up dataflow:** polite-ai's Stripe webhook → calls llm-agent **credit endpoint**
  `POST /api/organisations/{id}/balance/credit` with `idempotencyKey = PaymentIntent.id`
  (**unique-constrained** in llm-agent); on a failed credit the webhook returns **500** so Stripe retries
  (and the llm-agent unique key makes the retry safe). A reconciliation sweep keyed on `pi.id` covers
  Stripe-charged-but-credit-lost.
- polite-ai `billing_accounts`/`ledger_entries` → **Stripe-side bookkeeping only** (customer, PMs,
  subscription, invoices); they no longer hold the spendable balance.
- **Micro-pence ↔ pence** crosses a 1e4 scale at every hop → one shared helper (micro-pence internal,
  **pennies at the API edge**) with a scale-assertion test. GBP-only v1 (pin/assert currency).
- **Callbacks (designed, not built):** model on the existing **HMAC-signed** outbound webhook
  `lib/call-hook.js`; decide at-least-once vs at-most-once (schema impact) and edge-vs-level firing; close
  its known SSRF/allow-list gap. Fire `balanceLow`/`balanceNegative`; the frontend reacts (top-up or set
  `billingBlocked`).

---

## 7. API, RBAC & read-path

- **RBAC:** new `rate` resource (`read/readAll/create/update/delete`, cross-tenant via `readAll`, granted
  to `superAdmin`) + `organisation:setRate` (mirrors `setLimits`).
- **Endpoints:** `/api/rates` CRUD; `/api/organisations/{id}/rate-history` (assign as-of date);
  `/api/organisations/{id}/balance` (read) + `/balance/credit` (idempotent); `/api/rate-components`
  (canonical, **env-independent** catalogue built from in-tree constants with availability metadata — never
  drop uncredentialed components; live ElevenLabs/Ultravox/Google enumeration is decoration only). Per
  component it advertises the **available billing unit(s)** — model: token and/or minute; **TTS/STT:
  characters and/or time, per engine, per handler** — so the UI only offers a basis that has a live meter.
- **Read path:** extend `/api/usage` to return `SUM(cost_micros)` + **explicit `uncostedMeters` count**
  (`COUNT FILTER WHERE cost_micros IS NULL`) + currency/rateName dims, bucketed on `billedAt`.
  **Sequence:** llm-agent ships cost first → polite-ai switches reads (keep `priceUsagePennies` as
  null-cost fallback) → **then** retire the flat `RATE_CARD`.

---

## 8. polite-ai (Phase 4)

`dashboard.rates.tsx` (Admin nav, superAdmin-gated): rate-card list (`DataTable`) + a **component-grid
editor** (the `FunctionsEditor` repeating-rows pattern) **driven by `/api/rate-components`** — decomposes
the roster by audio-path(handler×media) / model(realtime per-min vs pipeline per-token) / TTS-vendor /
STT-vendor and prompts the correct metric per component, with `startDate`/`endDate`; plus org
rate-assignment timeline. Billing/usage pages read stamped cost + balance from llm-agent; Stripe top-up
credits llm-agent; PLANS become packaging.

---

## 9. Phased plan

0. **Schema + migration** (v44): `RateCard` (+ EXCLUDE-gist raw DDL), `Organisation.{rateHistory,balance,billingConfig,billingBlocked}`, `usage_records.{billedAt,media,costMicros,appliedCostMicros,currency,rateName,rateCardStart,costStatus}`. One `DB_FORCE_SYNC` deploy, low-traffic (index locks on populated `usage_records`).
1. **Capture completeness:** vendor normalisation (R3), media-at-write + Jambonz fix (R2/D3), TTS/STT dual-basis metering — Pipecat STT, STT-characters, Pipecat TTS-duration (D4/Q-G), LiveKit consult-leg LLM/STT/TTS metering (R2/Q-B), text finalisation. Outcome: every priced component is metered on each basis it may be billed on, self-describing, with `billedAt`.
2. **Costing engine** (`lib/rates.js`): additive resolver, `billedAt`, `settle()` (atomic, idempotent), never-throw + `costStatus`, choke-point routing, nightly sweep/backfill.
3. **Admin API + RBAC:** `rate` resource, `/api/rates`, `/api/rate-components`, balance read/credit, cost in `/api/usage`.
4. **polite-ai UI + billing rewire:** `dashboard.rates.tsx`, retire `RATE_CARD` (sequenced), wallet→Stripe-ledger, balance seed migration.
5. **Deferred:** balance callbacks + SSRF fix; hot-path refusal (`billingBlocked` enforcement); agentless passthrough *product*; per-user rate override (resolver hook left in place).

---

## 10. Detail-level questions — RESOLVED

- **Q-A (authoring) — RESOLVED:** the `model` dimension is **per-model, not per-class** (§2). The catalogue
  advertises each model's real billing metric(s) — token and/or minute — and the UI **guides** but does
  **not** hard-block; only the same-meter double-charge guardrail is enforced. `gpt-realtime` = token-billed
  (audio-path minutes still apply); Ultravox = minute-billed; a future model may carry both.
- **Q-B (consult) — RESOLVED:** charge **both** concurrent legs' audio-path; **close the LiveKit consult
  LLM/STT/TTS metering gap in v1** so the consult leg is fully itemised (§5.3, Phase 1).
- **Q-C (correction invariant) — RESOLVED (default accepted):** rate cards are **immutable once referenced**;
  a price change is a new card with a later `startDate` (supersede). Enforced by a `beforeUpdate` guard.
- **Q-D (in-flight overshoot) — RESOLVED:** **accept as a sized v1 risk** — document worst-case
  = concurrent calls × max-call-length × rate (bounded by `agentLimit`), ship a sane default `agentLimit`;
  hot-path refusal deferred to phase 5. No mid-call flush in v1.
- **Q-E (text anchor) — RESOLVED (default accepted):** session-start anchor = `metadata.startedAt` stamped
  on the **first row** of the text session (deterministic, no `MIN` scan).
- **Q-G (TTS/STT billing basis) — RESOLVED:** TTS **and** STT can be priced by **characters OR time**,
  chosen **per engine**, with different engines on the same handler differing (§2, §5.4). Schema supports it
  natively (lines keyed on provider+unit); the constraint is metering, so Phase 1 emits **both** bases where
  the engine/SDK exposes them and `/api/rate-components` advertises per-engine which units are live. The
  same-engine double-charge guardrail (one unit per engine per synthesis) is unchanged.
- **Q-F (kickoff) — PENDING:** owner is **reviewing this spec** before implementation; worktree/branch
  setup happens on greenlight.
