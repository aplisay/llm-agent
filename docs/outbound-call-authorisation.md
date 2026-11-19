# Outbound call authorisation

Every path that puts a call *out* of the platform — the originate API, a blind or
consultative `transfer`, a WebRTC bridge leg, an agent's last-resort
`fallback.number` — passes through one policy: **`lib/outbound-authorisation.js`**.

There is exactly one implementation. The workers do not carry their own copy: the
LiveKit and Pipecat workers call `POST /api/agent-db/outbound-authorisation` (an
internal, `x-shared-token` route) and treat any failure to reach it as a refusal.

## Why the agent's own filter cannot be the whole story

`agents.options.outboundCallFilter` is a **tenant-controlled** value. It is a good
tool for an agent author who wants to pin their agent to a handful of numbers, and
that is exactly how it is documented in [call-transfers.md](call-transfers.md).

It is not a control the *operator* can rely on, because the person who writes the
filter is the person we would be protecting ourselves from. An agent whose filter
is `^\+?\d+$` — or an agent with a narrow filter whose destination arrives from a
CRM field an attacker can write — can dial international premium-rate and
revenue-share ranges. When that call leaves on one of **our** carrier trunks, we
pay the carrier. That is the classic toll-fraud monetisation path, and it can run
up five figures in a day.

So the policy splits on one question: **whose minutes are at risk?**

## The two cases

### 1. Not our carrier — the agent's filter is authoritative

A leg that egresses a **registration B2BUA** (the customer's own PBX), a BYO
trunk, or any trunk not flagged `chargeable` costs us nothing. Behaviour here is
unchanged from before this policy existed:

* `options.outboundCallFilter` if the agent sets one;
* otherwise the historical default: a UK geographic, non-geographic or mobile
  number in any of the accepted dialled forms, without 070 and 076 but with
  07624 (`^(\+44|44|0)(?!70|76(?!24))[1237]\d{6,15}$`). See [Narrowings](#narrowings).

### 2. Our chargeable carrier trunk — the operator's policy is authoritative

A leg that egresses a trunk with `Trunk.chargeable = true` is carried at our cost
(this is the same flag that drives destination billing — see
[implementation/rate-cards-STATUS.md](implementation/rate-cards-STATUS.md)). The
destination must satisfy **all** of:

| # | Gate | Source |
|---|------|--------|
| a | `Trunk.outboundCallFilter`: the operator's allow-pattern, applied to the canonical `+E.164` destination. Unset ⇒ UK geographic/mobile without 070 and 076 but with 07624: `^\+44(?!70|76(?!24))[1237]\d{8,9}$` | operator (superAdmin) |
| b | **Rateable** — the destination longest-prefix-matches a prefix in the tariff named by the `destination` line of the rate card in force for this org/user | operator (rate cards + tariffs) |
| c | `options.outboundCallFilter`, when the agent sets one | tenant — **narrows only** |
| d | The organisation's outbound policy, for an organisation with the phone system. See below | the organisation's admin, within the brand's ceiling |

(c) can only ever remove destinations that (a) and (b) already permit. A wide-open
agent filter buys nothing on a chargeable trunk.

Gate (b) is deliberately the same resolution the costing engine performs at call
end (`costUsageRow` → per-user rate override, then the organisation's, then the
covering rate card, its `destination` line, the effective tariff, longest-prefix
match). **If we cannot price the call, we do not carry it** — which also means a
destination cannot be dialled before it has been added to the tariff deck.

## The organisation's outbound policy

An organisation with the phone system capability has its own outbound policy
(`lib/outbound-policy.js`). It is gate (d), so it applies to every outside leg on
our chargeable trunks: phones, agent transfers and the originate API. It does not
apply on a trunk we do not pay for, or to an organisation without the phone system.

| Part | Default |
|---|---|
| Destination classes, below | The first three open, the rest closed. A UK number in no class, such as 05, is refused |
| `callsInProgress`: outside calls in progress at once. Calls inside the organisation do not count | The ceiling |
| `callsPerMinute`: outside calls started in any 60 seconds | The ceiling |
| `spendPerDayMicros`, `spendPerMonthMicros`: what outside calls cost, in micros of a pound, by the local day and month. See "Spend" below: they do not yet move for phone system calls | The ceiling |
| `hours`: the days and times outside calls may be made, in a time zone | None: any time |

| Class | Numbers |
|---|---|
| `ukLandline` | 01, 02, 03, including Reading's 0118 |
| `ukMobile` | 07, without 070 and 076 |
| `freephone` | 0800, 0808 |
| `service` | 084, 087 |
| `premium` | 09, directory enquiries (the six digits 118xxx), 070 personal numbers, 076 pagers |
| `crownDependencies` | The area codes 01481 (Guernsey), 01534 (Jersey) and 01624 (Isle of Man), and the 07 blocks Ofcom lists as allocated to the islands' providers, which include the Isle of Man's 07624. The list is from Ofcom's number file of 18 November 2026, in `lib/outbound-policy.js` |
| `international` | Any number outside +44 |

**The ceiling.** Each brand has a ceiling, `outboundCeiling` on
`PUT /api/brands/{brandId}` (platform operator only). An organisation's admin or
owner sets the policy with `PUT /api/organisations/{id}/outbound-policy`, and a
value wider than the ceiling is refused with `above_ceiling`. A brand with no
ceiling, and each field a brand leaves out, takes the platform's: the three
default classes, 10 calls in progress, 10 calls a minute, £50 a day and £500 a
month. There is no "no ceiling". If a brand lowers its ceiling, the lower value
applies at once.

`GET /api/organisations/{id}/outbound-policy` shows the policy, the ceiling,
what applies (`effective`), what the limits count now (`usage`) and today's
refusals by code (`notices`). If a stored hours rule no longer checks, every
outside call is refused: `effective.hoursValid` is then false and
`effective.hours` shows the rule as stored.

**What it counts.** For each organisation, the count and the write of the
decision are one step under a lock, so calls decided at the same moment cannot
all pass a limit. A call is in progress from the decision that allowed it.
Until the call has a row, the decision holds its place for up to two minutes.
A phone system leg has a row once the network answers it; a leg that rings out
gives its place back when the two minutes end. After that the live call row,
on a chargeable trunk, holds the place until the call ends. A row older than
four hours is not counted, so a call record left open by a lost write does not
hold a place for good. Calls a minute counts the allowed decisions of the last
60 seconds.

**Spend.** Spend is read through `lib/outbound-spend.js`. It counts the costed
usage rows of finished calls that carry a destination charge. **Phone system
calls write no usage yet, so until billing writes their usage the daily and
monthly spend limits do not move for them.** A call in progress is not counted
until it ends and is costed.

**The notice.** Each decision is written to `outbound_events`. The first refusal
by a limit on a day for an organisation sends one `outboundLimitReached` event
to the organisation's billing callback (`billingConfig.callbackUrl`), signed
with its `hashKey` over `hashKey|organisationId|outboundLimitReached|code|day`.
One notice a day covers every limit. If the send fails, the next refusal by a
limit that day sends it. The front end sends the email to the organisation's
admins. Decisions are kept for 40 days.

**It fails closed.** If the policy cannot be read, or a count cannot be made, or
the decision cannot be written, the call is refused with
`outbound_policy_unavailable`.

**Deploying it.** The policy needs the schema 75 upgrade
(`tools/agent-admin.js upgrade-db`) and then a restart of the API server, which
reads the schema at start. Until both are done, every outside call on our
chargeable trunks of an organisation with the phone system is refused with
`outbound_policy_not_ready`: its agents' calls as well as its phones'. The
policy route answers 503. Run the upgrade and the restart together with the
deploy.

## Narrowings

Changes that remove destinations an agent could dial before. Each is in the
tests (`tests/outbound-policy.test.mjs`).

| Since | What |
|---|---|
| The release with the organisation's outbound policy. It applies as soon as the code runs, with no upgrade | 070 (personal numbers) and 076 (pagers) are closed in both default filters, the agent default and the trunk default, for every brand. They are charged like premium numbers. The Isle of Man's mobiles, 07624, stay open. An agent or trunk filter that names them still opens them on a trunk we do not pay for, or on a trunk whose operator filter allows them |

## Refusal codes

The decision returns `{ allowed, code, reason, chargeable, trunkId, destination }`.

| `code` | Meaning |
|--------|---------|
| `ok` | Permitted |
| `default_filter` | No agent filter; failed the historical UK default |
| `agent_filter` | Failed the agent's own `options.outboundCallFilter` |
| `trunk_filter` | Failed the egress trunk's operator allow-pattern |
| `not_rateable` | We hold no rate/tariff that prices this destination for this organisation |
| `invalid_destination` | Not a dialable number at all |
| `internal_extension_not_reachable` | The digits are the number of one of the organisation's phone system extensions, which only a phone system call can ring ([phone-system.md](phone-system.md)). Not checked until the database has the phone system schema |
| `destination_class` | The organisation's outbound policy does not allow the destination's class. `destinationClass` names it, or is null for a UK number in no class |
| `outside_hours` | Outside the hours of the organisation's outbound policy |
| `calls_in_progress_limit`, `calls_per_minute_limit`, `daily_spend_limit`, `monthly_spend_limit` | A limit of the organisation's outbound policy is reached. `limit`, `value` and `current` say which and by how much |
| `outbound_policy_unavailable` | The policy could not decide, so the call is refused |
| `outbound_policy_not_ready` | The database lacks the schema 75 upgrade |

The originate API returns these as a `400` with `error` and `code`. In a worker
the refusal surfaces to the model as the `transfer` tool's failure reason, so the
agent can tell the caller rather than silently stalling.

## Configuring a trunk filter

`Trunk.outboundCallFilter` is superAdmin-only, on the existing trunk endpoints:

```bash
curl -X PATCH "$API/api/trunks/$TRUNK_ID" \
  -H 'content-type: application/json' \
  -d '{"outboundCallFilter": "^\\+44[1237]\\d{8,9}$"}'
```

Notes:

* it is matched against the **canonical `+E.164`** form, so there is one way to
  write it regardless of how the number was dialled (`07700…`, `447700…`,
  `+447700…` all normalise first);
* `null` (or an empty string) restores the UK geographic/mobile default — it never
  means "allow everything";
* patterns are capped at 512 characters and must compile; an unusable pattern is
  rejected at write time, and if one ever reaches the gate it is treated as *no
  match* (fail closed);
* it is ignored on a non-chargeable trunk, where case 1 applies.

## Failure modes

* **Platform unreachable from a worker** — the transfer is refused. The gate
  protects a cost we cannot undo, so "cannot decide" resolves to "no".
* **A chargeable trunk with no tariff coverage yet** — everything is refused with
  `not_rateable`. Load the tariff deck before enabling the trunk.
* **`APLISAY_OUTBOUND_TRUNK_ID` unset** — the platform's public trunk is not
  identified, so a carried leg resolves to whatever trunk the caller number's
  `aplisayId` names. This is the same env the workers stamp destination billing
  from; set it consistently on the API server and both workers.

## Where it is enforced

| Path | Enforcement |
|------|-------------|
| `POST /api/listener/{id}/originate` | in-process, all handlers |
| Call control, before every outside leg of a phone system call | `POST /api/agent-db/pbx/outbound-authorisation` |
| LiveKit worker `transfer` (blind, consultative, bridge) | `validateTransferArgs` → internal endpoint |
| Pipecat worker `transfer` (blind, consultative, WebRTC relay) | `_on_transfer` → `outbound_filter.py` → internal endpoint |
| LiveKit worker `fallback.number` | same gate as a tool-call transfer (`transferOnly` → `handleTransfer`) |
| Pipecat worker `fallback.number` | same gate as a tool-call transfer (`authorise_destination` before the blind transfer) |
| jambonz / native Ultravox | no outbound or transfer capability; nothing to gate |
