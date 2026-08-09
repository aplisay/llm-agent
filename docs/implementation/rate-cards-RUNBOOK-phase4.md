# Billing rate-cards — Phase 4/5 run-verification runbook

Phases 0–5 are **code-complete**. Phases 0–3 and 5 are unit-verified against the
test DB; **Phase 4 (polite-ai UI + the Stripe/balance rewire) is typecheck/build-
green but not yet exercised against a live environment.** This runbook is the
provisioning + verification checklist to take it live.

Repos / branches: `llm-agent` `billing`, `polite-ai` `billing`, `test-agent` `billing`.

## 0. Schema — DONE on dev

The dev DB (`llmvoicedev`) is already at **dbVersion 47** with every billing
column/table present (`rate_cards`, `balance_credits`, `users.rate_history`,
`organisations.{balance,billing_config,billing_blocked,rate_history}`,
`usage_records.{billed_at,media,cost_micros,cost_status,…}`). Verified by direct
inspection. **Staging/prod still need a `DB_FORCE_SYNC` boot** to reach v47.

## 1. Provisioning (needs you — accounts/secrets)

### 1a. The billing-service credential (for the Stripe webhook)
The webhook authenticates to llm-agent's `POST /balance/credit` as a synthetic,
least-privilege identity (role `billingService` → grants ONLY `organisation:credit`).

```sh
# against the target env's DB (same POSTGRES_* the app uses):
cd llm-agent && NODE_PATH=./node_modules node scripts/provision-billing-service.mjs
# prints:  LLM_AGENT_BILLING_TOKEN=bsvc_…
```
Put that token in **polite-ai**'s env as `LLM_AGENT_BILLING_TOKEN`. Until it is set,
the webhook gracefully falls back to crediting the local wallet only (no llm-agent
credit), so nothing breaks pre-cutover.

### 1b. Stripe test webhook
Point a **test-mode** Stripe webhook at `POST {polite-ai}/api/stripe-webhook` for
`payment_intent.succeeded` (+ the subscription events already handled). The polite-ai
top-up flow already stamps the PaymentIntent metadata `{ kind: 'wallet_topup',
organisationId }`, so a test top-up from the billing page produces a valid event.

### 1c. Nightly sweep scheduler (optional, Phase 5)
Point a scheduler (cron / Cloud Scheduler) at `POST {llm-agent}/api/agent-db/sweep`
with header `x-shared-token: $SHARED_API_TOKEN` (the internal token), body
`{ "limit": 500, "maxBatches": 10 }`. Nightly is plenty.

## 2. Verification checklist

Log in to polite-ai as a **superAdmin**.

1. **Rate-card editor** — `Platform → Rate cards`. Create a card (e.g. audio-path
   `LiveKit · webrtc` @ some pence/min + model `Ultravox` @ some pence/min). Save.
   Assign it to a test org (Assign → pick the rate, a start date). Expect 200s.
2. **Stamped cost** — make a test call on that org; after it ends, confirm the cost
   stamped: `GET /api/usage?callId=<id>` (or the billing page month-cost) shows
   `costMicros` non-null, or in SQL `select cost_status, cost_micros from
   usage_records where call_id='…'` → `matched` + a value. (`/api/agent-db/sweep`
   can backfill any `no_rate`/uncosted rows after assigning the rate.)
3. **Balance read** — `Dashboard → Billing`. After seeding (step 4) the balance
   should read from llm-agent (`GET /api/organisations/{id}/balance`).
4. **Seed** — on the Rates page click **Seed balances from wallet** → each org's
   local `billing_accounts.balance_pennies` is credited into llm-agent
   (idempotent `seed:<orgId>`; re-running is safe). Confirm `organisations.balance`.
5. **Stripe top-up** — do a test top-up on the billing page → the webhook credits
   llm-agent's balance. **Re-deliver the same event** from the Stripe dashboard →
   the balance must NOT double (idempotency on `PaymentIntent.id`).
6. **billingBlocked** — set a test org `billingBlocked=true` (SQL or admin) → a new
   call is refused (`Call.start()` throws `BILLING_BLOCKED`, status `failed:
   billing blocked`). Set it back to false → calls work.
7. **Balance callbacks (optional)** — set an org `billing_config =
   {"callbackUrl":"https://<public>/hook","hashKey":"…","balanceLowPennies":N}`;
   drive usage so a settle crosses the threshold → a signed `balanceLow` /
   `balanceNegative` POST fires (only to **public** URLs — the SSRF guard blocks
   private/loopback targets).

## 3. Known follow-ups (not blockers)
- **Full `RATE_CARD` removal** in polite-ai once all usage is stamped (it is a
  fallback today for not-yet-costed rows).
- **Webhook SSRF**: the guard resolves the host and blocks non-public IPs +
  refuses redirects; a small DNS-rebind TOCTOU window remains (pinning the
  resolved IP at connect time is a deeper follow-up).
- **Agentless passthrough** product — a feature, out of scope here.
