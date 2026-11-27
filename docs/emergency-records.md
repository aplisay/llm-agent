# Emergency address records

When someone calls 999 or 112, the emergency services are given an address for the number the call shows. The carrier that supplies the number holds that address. This page calls it the number's record.

This platform does not send records to a carrier. A separate service does that: it sends each record, reads its status once a day, and checks it once a year. The platform holds the state of each record, and that service reads and writes the state through the four routes on this page.

If you run the platform without such a service, nothing here fills the carrier's database. You must give your carrier an address for each number yourself.

This part of the API is under development, with the [phone system](phone-system.md).

## Which numbers have a record here

A number has a record here when both are true:

- its trunk's provider is `magrathea` (`flags.provider` on the trunk, set with `provider` on `POST /trunks`);
- its organisation has the `phoneSystem` capability.

Every other number is absent from the list, and the routes answer 404 for it. A number on a customer's own trunk has its record at that customer's carrier, which the platform cannot see.

A number is expected on one such trunk only. If it is on two, the row created first is its record.

## The record

| Field | Meaning |
|---|---|
| `number` | The number, in digits with its country code and no `+` |
| `organisationId` | The organisation that holds the number |
| `version` | An opaque value. See "The version" below |
| `mode` | Whose address the record should hold: `organisation` (the default), `own` (the number has its own), or `carrier` (kept at the carrier of the number's owner) |
| `address` | The address in force: the number's own in mode `own`, else the organisation's. Null when there is none |
| `sent` | What the carrier last took. Null when nothing has been sent |
| `state` | See below |
| `stateSince` | When the state last changed to its present value |
| `code` | The carrier's last status code |
| `reason` | The carrier's reason for a rejection, or why a record does not match |
| `submittedAt`, `checkedAt` | When the record was last submitted, and when its status was last read |
| `error`, `errorAt` | Why the address in force is not at the carrier, and since when. Null when it is |

The state describes the carrier's record. A change that could not be sent does not move it: it is stored as `error`.

| `state` | Meaning |
|---|---|
| `not_entered` | Nothing is at the carrier. A number that has never had a record reads as this |
| `draft` | The carrier has fields and has not been asked to check them |
| `invalid` | The carrier's first check refused the address |
| `submitted` | The carrier is checking the record. This can take several working days |
| `accepted` | The carrier accepted the record |
| `rejected` | The carrier rejected the record. `reason` says why |
| `mismatch` | The carrier's record is not the address that was meant |
| `carrier` | Kept at the carrier of the number's owner. Not sent from here |

## The service key

The routes take a key of the `emergencyService` role and no other. An owner, an organisation admin, a platform operator, every other service key and the workers' shared token all get 403.

```shell
node scripts/provision-emergency-service.mjs -p /path/to/your.env
```

It prints the key once. Give it to the sending service and store it nowhere else. The key opens nothing but these four routes. A platform operator cannot give the role or its permission to a user through the API.

The service has one key. A second run of the script stops and changes nothing. To replace the key, run it with `--rotate`: it prints a new key and deletes the old one, which stops working at once.

No other route gives every organisation's records. An organisation's own users read the records of their own numbers through two more routes: see [for an organisation's own users](#for-an-organisations-own-users). The internal routes that send a whole number row to the workers leave the record out, and so does an agent read with its listeners' numbers.

## The routes

All four answer 503 `emergency_records_not_ready` until the database has had the schema 81 upgrade (see the end of this page).

### `GET /emergency-records?states=a,b&after=<number>&limit=n`

A page of records, in number order: `{ "items": [...], "next": "<number>" }`. `next` is null on the last page.

- `states` is a list of states separated by commas. With none, every state.
- Paging is by number, not by offset: pass the `next` of one page as the `after` of the following one. Rows change state while a caller pages through them, and an offset would then skip or repeat one. `after` is empty for the first page.
- `limit` is a whole number from 1 to 500. The default is 200.

### `GET /emergency-records/{number}`

One record as it is now. 404 when the number has no record here. A leading `+` on the number is accepted. On this route and the two below, 400 when the number is not digits.

### `POST /emergency-records/{number}/claim`

Body: `{ "expect": { "organisationId": "...", "version": "..." } }`.

A claim takes a number for one send, so that two senders cannot both send its record to the carrier. It lasts ten minutes. The answer is the record with a new `version`, which the write that follows must name.

409 when a claim is live (`claimed`), when the record is not the one that was read (`changed`), or when the number belongs to another organisation now (`organisation_changed`). Of two claims of one number at the same instant, one is given.

### `PUT /emergency-records/{number}`

Body: `{ "expect": { "organisationId": "...", "version": "..." }, ...fields }`. The fields are `state`, `code`, `reason`, `sent`, `submittedAt`, `checkedAt`, `error` and `errorAt`. Send only those to change. The answer is the record after the write.

| Status | When |
|---|---|
| 200 | Written |
| 400 | A field has the wrong form, or is not one the key may write, or the number is not digits |
| 404 | The number has no record here |
| 409 | The record is not as `expect` says: `changed`, `organisation_changed`, or `claimed` when another send holds the number |
| 422 | The key may not make this change of state: `move_not_allowed` or `state_required` |

Any write that is taken ends the claim.

## The version

A claim or a write names the `organisationId` and the `version` it read. It is refused with 409 when the record is no longer that one. Without this, a slow run could write over an admin's newer address, or over a number that has moved to another organisation.

The version changes when any of these change:

- anything in the record (every write, and every claim);
- the number's organisation;
- its mode;
- the address in force. So it changes for every number in mode `organisation` when the organisation's address changes.

Treat it as opaque. Read the record again to get the present one.

## A write that follows a claim

The holder of a claim names the version the claim gave. Its write is then taken **whatever happened to the address in force since the claim was made**. The reason: the carrier has already taken the record. If the platform refused to note it because an admin saved a newer address during the send, the submit would be forgotten, and the next run would submit again while the carrier is still checking the first. With the write taken, the record says `submitted` with what was sent, and the newer address waits as a change.

- **One exception: the number has moved to another organisation.** Then the answer is 409 even for the holder. The record at the carrier is the last holder's.
- While a claim is live, nobody else may write the record, even naming the version they read.
- A claim also ends with its time. After that anyone may claim the number, or write the record as they read it. The holder's own write is still taken after its ten minutes, as long as no other claim or write has come between.
- No change of state needs a claim. A sender that lost its claim reads the record again and writes the result on it as it is now. The claim is what stops two sends at once.

## The changes of state the key may make

The key must not be able to choose a state freely. `accepted` is reached only from `submitted`, with the carrier's code 0. Anything not in this table answers 422.

| From | To | Only with |
|---|---|---|
| `not_entered`, `draft`, `invalid`, `accepted`, `rejected`, `mismatch` | `submitted` | `sent`, `submittedAt` |
| the same six | `invalid` | `sent` |
| the same six | `mismatch` | |
| `submitted` | `accepted` | `code: 0` |
| `submitted` | `mismatch` | `code: 0` |
| `submitted` | `rejected` | `code: 8` |
| `submitted` | `draft` | `code: 1` and `sent: null` |
| `submitted` | `not_entered` | `code: 9` and `sent: null` |
| `submitted` | `submitted` | `code` 2, 3, 6 or null |

- A send carries no status code: in the first three rows `code` is null or absent.
- `sent: null` is taken only with code 1 or 9, and is required then.
- A non-null `sent` is taken only with a move to `submitted` or `invalid`.
- A write with no `state` may carry `checkedAt`, `error` and `errorAt` only.
- The key never writes `carrier`, and never moves a number out of it.
- The platform sets `stateSince` itself, on a change of state only.
- `reason` and `error` are cut at 2,000 characters.

## A number that changes hands

When a number moves to another organisation, or to the unallocated pool, its record starts again: state `not_entered`, nothing sent, no error, no claim, mode `organisation`, and no address of its own. The record belonged to the organisation that held the number.

The carrier may still hold the last holder's address after such a move, and after a number is released. The platform keeps no note of that yet.

## Calls out from a number with a rejected record

A call out that would show a number whose record is `rejected` is stopped. Calls start again as soon as the record is sent again and its state is `submitted`. No other state stops a call.

The rule is in the [outbound authorisation](outbound-call-authorisation.md), for a caller that names the number a leg will show. Call control names it on every outside leg of a phone system call (`presentNumber` on `POST /agent-db/pbx/outbound-authorisation`). The refusal is `emergency_record_rejected`.

- A rejected main number therefore stops outside calls from every extension that has no number of its own.
- For a mobile that is rung for a call in, call control names the extension's own number, which the leg shows if the carrier refuses the caller's. So such a leg is stopped too.
- Calls that an agent places or transfers are not covered: the workers do not name the number they show.

**This rule never stops an emergency call.** A call to 999 or 112 from a line the platform knows gets a plan with `action: "emergency"` and the number the line shows, whatever the state of that number's record, and even when the organisation's phone system is switched off. Call control places the call from that plan, and does not ask the outbound authorisation. The plan reports the record's state in `emergency.addressState`, for the call record.

The outbound authorisation is not a way to place an emergency call. Asked about 999 or 112, it answers as it did before this rule: on a platform trunk it refuses the destination with `invalid_destination`. This rule is not applied to those two numbers, so `emergency_record_rejected` is never the answer for them.

## For an organisation's own users

Two routes let an organisation see the records of its own numbers, and choose which address each should hold. They send nothing to a carrier.

### Who may do what

| Caller | Reads | Sets |
|---|---|---|
| A member | The state of each record: `number`, `mode`, `state`, `stateSince`, `submittedAt`, `checkedAt` and `stopsCalls`. No address, and none of the carrier's words | No |
| An owner, an organisation admin | All of it, with the addresses | Yes |
| Support | All of it, for an organisation it names with `?organisationId=` | No |
| A platform operator | All of it, for an organisation it names | Yes |
| A service key, the workers' token, the call control token | Nothing: 403 | No |

- Reading needs `phoneEndpoint:read`. The addresses and the carrier's words are added for a caller with `organisation:read`. A number's own address can be a person's home.
- Setting needs `organisation:update`, as the organisation's own address does.
- Another organisation's number answers 404, as a number with no record does.
- An organisation without the phone system answers 403 `phone_system_disabled`.

### `GET /emergency-addresses` and `GET /emergency-addresses/{number}`

The list answers `{ "items": [...] }`, in number order, with no paging. It has only the numbers that have a record here: see [which numbers have a record here](#which-numbers-have-a-record-here). The other route gives one item.

| Field | Meaning |
|---|---|
| `number` | The number, in digits with its country code and no `+` |
| `mode` | Which address the record should hold: `organisation` or `own` |
| `state`, `stateSince`, `submittedAt`, `checkedAt` | As in [the record](#the-record) |
| `stopsCalls` | True when calls out that show the number are stopped because of the record's state. Emergency calls are never stopped |
| `address` | The address in force. Null when there is none |
| `addressSummary` | The address in force on one line: its name, building, street and postcode |
| `ownAddress` | The number's own address, also while the organisation's is in force. Null when it has none |
| `sent` | What the carrier last took. It may be in the carrier's short forms, so a page that shows "a change is waiting" must apply the same short forms to `address` before it compares the two |
| `code`, `reason`, `error`, `errorAt` | As in the record |

### `PUT /emergency-addresses/{number}`

Body: `{ "mode": "own", "address": { "name": "...", "thoroughfare": "...", "postcode": "..." } }`. Send `mode`, `address`, or both. The answer is the record after the change.

- `mode` is `organisation` or `own`. `carrier` is refused with `mode_not_allowed`: a number that has a record here is at the platform's carrier.
- `address` is the number's own address. Its fields are `name`, `premises`, `thoroughfare`, `locality`, `postcode` and `businessSuffix`. It needs a name, a street and a postcode, as the organisation's address does. Other fields are dropped. Null removes the address.
- A number in mode `own` must have an address of its own: `address_required`.
- The number's own address is kept when its mode goes back to `organisation`.

| Status | When |
|---|---|
| 200 | Set |
| 400 | `invalid_request`, `invalid_address`, `address_required` or `mode_not_allowed`. A value of the wrong type is refused by the request check, with no `code` |
| 403 | The caller may not set it, or the organisation does not have the phone system |
| 404 | The organisation has no record for that number |

**What a change does.** It changes which address is in force, and nothing else. Nothing is sent. The state is not moved: it describes the carrier's record, which is still the older one. The record's [version](#the-version) changes, and the address in force now differs from `sent`. That is how the sending service finds a record to send on its next run. A send that read the record before the change is refused its claim with 409 `changed`.

- Until the service has sent the record again, a rejected record stays `rejected`, and calls out that show the number stay stopped.
- A change made while a send holds the number is kept, and so is the send's result. The record then says `submitted` with the older address in `sent`, and the newer one waits.
- A change to the organisation's own address (`PUT /organisations/{id}/phone-system`) does the same for every number in mode `organisation`.
- An emergency plan is never touched by a change. A call to 999 or 112 from a line gets the same plan before and after.

**Sending a rejected record again, with the same address, is not here.** It is not a change of state. The sending service sends a record when the address in force differs from what was sent, and for such a record it does not. The service itself may claim and send any record at any time: `rejected` to `submitted` is one of the changes its key may make.

## The database upgrade

The routes need the schema 81 upgrade (`tools/agent-admin.js upgrade-db`, see [upgrading](self-hosting/upgrading.md)), which adds nine columns to `phone_numbers`, and then a restart of the API server. Until both are done the four routes of the sending service and the two for an organisation's own users answer 503 `emergency_records_not_ready`, and everything else works as before.

The rule for calls out needs only the phone system upgrade (schema 73), which has the state.

## Not here yet

- A way for an organisation's admin to have a rejected record sent again with the same address.
- Notices to an organisation's admins when a record is rejected.
- A note on a number that the carrier may still hold an earlier holder's address.
