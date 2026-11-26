# The phone system: directory, phones and lines

This page describes the part of the API that lets desk phones register to the platform and ring for people. It is under development. It is off for every organisation until an operator switches it on.

## What is here today

- **The directory.** People, teams and services, and their extensions. Every organisation has one.
- **Phones.** Desk phones and outside numbers such as mobiles, and the people each one rings for.
- **Lines.** The keys of a desk phone, worked out by the platform. Each line has its own SIP account.
- **Number routing.** A number can ring an extension in place of an agent.
- **Internal routes for call control.** A separate service decides what each call does by asking this API. For a call that belongs to an agent, the answer names the agent.

Not here yet: the service that carries the calls, phone provisioning, hunt groups, queues, agents inside phone system calls, and charging.

## The two switches

| Switch | Where | What it does |
|---|---|---|
| The `phoneSystem` capability | `PUT /organisations/{id}/capabilities` with `{ "capabilities": ["phoneSystem"] }`. Needs `organisation:setCapabilities`: a platform operator for any organisation, or a brand's service key for the organisations of its brand. A new organisation starts with its brand's defaults (see below) | Switches the phone system on for one organisation. Without it every phone system request answers 403 with code `phone_system_disabled` |
| `PBX_RELEASE` | An environment variable of the API server | Which extension types and phone kinds the deployment accepts. Unset means `1`: types `connection` and `ring_all`, phones `deskphone` and `external` |

A second capability, `phoneRedirect`, lets an organisation's desk phones be bound in the vendor's redirect service (see [phone-provisioning.md](phone-provisioning.md)). Only a platform operator gives or takes it.

Taking the capability away deletes nothing. Calls are refused and the routes answer 403 until it is given back.

An organisation without the capability still has the directory, and extensions of type `connection`: numbers on its own phone system, reached through one of its connections.

The phone system needs the schema 72 and 73 database upgrades (`tools/agent-admin.js upgrade-db`, see [upgrading](self-hosting/upgrading.md)). Until they have run, the API server starts with the phone system off for everyone: the directory, phone, phone system settings and capabilities routes answer 503 with code `phone_system_not_ready`, as do the call control routes for extensions, lines and call events. Calls to agents, numbers and connections work as before. The outbound refusal of extension digits and the daily purge of removed rows do nothing until then. Restart the API server after the upgrade.

The organisation's outbound policy also needs the schema 77 upgrade and then a restart of the API server. Until both are done, the outside calls of an organisation with the phone system are refused on the platform's own trunks with `outbound_policy_not_ready`, its agents' calls as well as its phones'. The policy, its limits and the brand's ceiling are in [outbound call authorisation](outbound-call-authorisation.md#the-organisations-outbound-policy).

Billing for the phone system needs the schema 79 upgrade and then a restart of the API server. Until both are done nothing is charged, phone system calls write no usage, and an empty balance stops nothing. Charging starts on the day the upgrade ran, and no earlier day is charged. Each platform trunk that phone system calls leave by must be flagged `chargeable`; `yarn doctor` lists those that are not. The rate card's `extension` line and the trunk flags go in before the upgrade: the order is in [billing](billing-calls-from-usage.md#the-phone-system).

`GET /me` returns `organisation.capabilities`, so a front end can decide which pages to show without another request.

### Brands

A brand is a label on an organisation that says which front end its customers use. A platform operator creates a brand and sets the capabilities a new organisation of that brand starts with:

```shell
curl -s -X PUT -H "$H" -H 'Content-Type: application/json' $API/brands/acme \
  -d '{"name":"Acme","defaultCapabilities":["phoneSystem"]}'
```

A change to the defaults applies to organisations created afterwards. It does not touch existing ones.

`scripts/provision-brand-service.mjs --brand acme` mints a service key for that brand. The key may create organisations, which take its brand and the brand's defaults, list and read the organisations of its brand, and set their capabilities. It reaches no organisation of another brand. An organisation's brand is fixed once set. A platform operator may give a brand to an organisation that has none, with `PATCH /organisations/{id}`.

An organisation with no brand works as before. Brands need the schema 74 database upgrade (`tools/agent-admin.js upgrade-db`, see [upgrading](self-hosting/upgrading.md)). Until it has run, the API server starts with brands off: the brand routes, and a `brand` field on the organisation routes, answer 503 `brands_not_ready`. Restart the API server after the upgrade.

The owner of an organisation may read and change its phone system settings (`/organisations/{id}/phone-system`), for its own organisation only. It cannot change the organisation's status.

## How it fits together

An admin sets three things:

1. Which extensions a person belongs to. A person's own extension is the one on their directory entry. A team's or service's extension is shared, and people are added to it as members.
2. Which phones ring for a person (`/phones/{id}/people`).
3. What type each extension is, with its settings.

Everything else is worked out. For each desk phone the platform takes the people it rings for, puts each person's own extension first, then their shared extensions in each person's key order, and gives each one a key. If there are more extensions than the phone has lines, the last key becomes an overflow line that takes calls for all the rest.

A phone rings for at most one person fewer than it has lines, and a one-line phone for one. More is refused with `phone_too_small`.

A line is known by its phone and its extension. While that pair lasts, the line keeps its SIP account and its line number, even when its key moves. Lines are read-only: `GET /phones/{id}/lines`. `GET /phones/{id}/changes` records why a phone's keys changed.

## Changing several things at once

`POST /directory/batch` applies a list of changes in one go: all of them, or none. Each op is one of `entry.create`, `entry.update`, `entry.delete`, `entry.restore`, `extension.create`, `extension.update`, `extension.delete`, `extension.restore`, `member.add`, `member.remove`, `keyOrder.set` and `huntOrder.set`. An op may name the row it creates with `ref`, and a later op may use `"$name"` in place of that row's id:

```json
{
  "actor": "import",
  "ops": [
    { "op": "entry.create", "ref": "dan", "entry": { "kind": "person", "name": "Dan Price" } },
    { "op": "extension.create", "extension": { "number": "106", "type": "ring_all", "entryId": "$dan" } },
    { "op": "member.add", "extensionId": "<id of Sales>", "entryId": "$dan" }
  ]
}
```

A batch holds at most 500 ops. When one is refused nothing is changed, and the answer is 400 `batch_failed` with a result for each op up to and including the refused one. A batch takes `?dryRun=true` like any other write.

## Removing and restoring

Removing an entry or an extension keeps it for 30 days. `POST /directory/entries/{id}/restore` brings an entry back with the extension removed with it, and with its memberships and phones. `POST /directory/extensions/{id}/restore` brings back an extension on its own. A restore is refused when the extension's number has been taken since. After 30 days the server purges removed rows for good.

`GET /directory/extensions/next-number` gives the lowest free number of the usual length, or of the length of `?near=`.

`GET /directory/extensions/{id}/rings-now` shows what a call to an extension would ring now, phone by phone, with each phone that is not registered marked offline. Whether a phone is in a call is not known there.

## The directory for agents

`GET /directory/lookup?query=` and `GET /directory/resolve?query=` (or `?contact_id=`) answer the agent tools `directory_lookup` and `directory_resolve`. They need `directory:lookup`. A lookup never shows a person's numbers or anyone's email. A resolve gives the numbers of its one match for the transfer step, and saved agents hide them from the model by name. With the phone system on, an entry whose extension is one of ours and who has no direct number gets the number that extension shows as `direct`, so an agent that cannot ring the extension rings that number.

The knowledge service has its own key, minted by `scripts/provision-knowledge-service.mjs`. It reads any organisation's directory when it names it with `?organisationId=`. It writes only through `POST /directory/batch` with `"actor": "crawl"`, and then only `entry.create`, `entry.update` and `extension.create` of type `connection`.

An agent that is not in a phone system call cannot ring one of our extensions. The outbound authorisation refuses digits that are the number of a live extension of the organisation, of any type but `connection`, with the code `internal_extension_not_reachable`. The agent then tries its next target.

## Dry runs

Every write that can change a phone's keys takes `?dryRun=true`. It checks the request, changes nothing, and returns an `effect` document: each phone affected, its keys before and after, and a one-line summary. The real write returns the same document.

## A short example

```shell
API=http://localhost:4000/api
H="Authorization: Bearer $KEY"

# A person with their own extension, and a team they belong to
curl -s -H "$H" -H 'Content-Type: application/json' $API/directory/entries \
  -d '{"kind":"person","name":"Ada Byron","extension":"100","extensionType":"ring_all"}'
curl -s -H "$H" -H 'Content-Type: application/json' $API/directory/entries \
  -d '{"kind":"team","name":"Sales","extension":"200","extensionType":"ring_all"}'
curl -s -H "$H" -H 'Content-Type: application/json' \
  $API/directory/extensions/$SALES_EXTENSION_ID/members -d "{\"entryId\":\"$ADA_ENTRY_ID\"}"

# A desk phone that rings for her. It gets two lines: 100 and Sales.
curl -s -H "$H" -H 'Content-Type: application/json' $API/phones \
  -d "{\"kind\":\"deskphone\",\"mac\":\"000413aabbcc\",\"model\":\"D717\",\"label\":\"Ada desk\",\"people\":[\"$ADA_ENTRY_ID\"]}"

# A number that rings Sales
curl -s -X PUT -H "$H" -H 'Content-Type: application/json' \
  $API/phone-endpoints/442079460810 -d "{\"extensionId\":\"$SALES_EXTENSION_ID\"}"
```

The platform keeps only a digest hash of a line's SIP password. The password is never stored, and no route shows it or the hash.

A Snom desk phone fetches its lines from the provisioning service: see [phone-provisioning.md](phone-provisioning.md).

To set a phone up by hand, `POST /phones/{phoneId}/lines/{lineId}/password-reset` gives the line a new password and returns it once. It needs `phone:provision` and the setting `PBX_LINE_PASSWORD_RESET=true`, and each reset is written to the audit log. The old password stops working at once. With the setting off (the default) the route answers 403 `line_password_reset_disabled`.

After an upgrade from a version that stored line passwords, `tools/agent-admin.js upgrade-db` empties them (schema 75). A stored password that cannot be opened (the upgrade ran without the right `CREDENTIALS_KEY`) is emptied too when the line has its hash, which is all a phone needs.

## Settings

| Variable | Use |
|---|---|
| `PBX_RELEASE` | See above |
| `PBX_REGISTRAR_DOMAIN` | The host name desk phones register to. It is the digest realm of every line's SIP account, so it cannot change once lines exist. Unset means `REGSERVER_REGISTRAR` |
| `PBX_LINE_PASSWORD_RESET` | `true` lets an admin reset a line's SIP password and read the new one once. Unset means off |
| `PROV_PUBLIC_URL` | The https address desk phones fetch their settings from. See [phone-provisioning.md](phone-provisioning.md) for the other `PROV_*` settings |
| `CALLCTL_SHARED_TOKEN` | The token call control sends as `x-callctl-token` |

## Internal routes for call control

These are under `/api/agent-db/pbx`. They take `x-callctl-token` only. The workers' `x-shared-token` does not open them, and the call control token opens nothing else. With `CALLCTL_SHARED_TOKEN` unset they are closed.

| Route | Use |
|---|---|
| `POST /agent-db/pbx/resolve` | What should this call do? The body is `{ callId, request }`. `request.kind` is `number` (a call in on a trunk: `calledNumber`, `trunkId`, `callerId`), `registration` (a call in from a registration: `registrationId`, `calledNumber`, `callerId`), `dialled` (digits from a line: `fromEndpoint`, `digits`), `extension` or `line` (follow-ups about a call in progress) |
| `POST /agent-db/pbx/outbound-authorisation` | May this leg to an outside number be placed? The same policy the agent workers use. The caller must fail closed |
| `POST /agent-db/pbx/calls` | Record a call, or an answered leg of one (`parentId`). The caller chooses the id, so a write sent twice is one row |
| `POST /agent-db/pbx/calls/{callId}/events` | Things that happened on a call and are not rows of their own, such as a phone that rang and was not answered. An outside leg that was not answered or not dialled gives back its place in the organisation's calls in progress ([outbound call authorisation](outbound-call-authorisation.md#the-organisations-outbound-policy)) |
| `POST /agent-db/pbx/calls/{callId}/end` | The call or leg has ended. It writes the call's usage. The call's own end may carry `recordedMs`, and any end `transcribedMs` ([billing](billing-calls-from-usage.md#the-phone-system)) |
| `POST /agent-db/pbx/resync/claim` | Which desk phones should be told to fetch their settings? The request may be held open. See [phone provisioning](phone-provisioning.md#telling-a-phone-that-its-settings-changed) |

`resolve` always answers 200 with a plan for a request it could decide. `action` is one of:

| `action` | Meaning |
|---|---|
| `ring` | Ring the legs of `ring.steps`, in order. A leg names a line of a phone (`lineId`, `lineNumber`, `key`, the SIP `endpoint`, and what to `display`) or an outside number. When the last step ends unanswered, do what `noAnswer` says |
| `outside` | A call from a line to an outside number. `outside.presentNumber` is the number to show |
| `emergency` | A 999 or 112 call. Always answered, whatever the organisation's switches |
| `connection` | Send the digits to the organisation's own phone system |
| `agent` | Hand the call to an agent. `agent` names it: `instanceId`, `agentId` and `runtime`. Today only for a call that goes straight to an agent (see below). An agent as an extension, or as a destination of one, is a later release |
| `forward` | Later releases |
| `refuse` | The call cannot be routed. `reason` says why, for example `number_not_routed`, `phone_system_disabled`, `charge_unpaid` (a monthly charge unpaid for 30 days; emergency calls still go out), or `organisation_deactivated` (see below) |

The plan applies what the directory knows: members, phones, lines, do-not-ring rules, and that an outside number rings only for its own person's own extension. It does not know whether a phone is busy or connected. Call control filters the legs by that.

A phone never rings for a call it places. When a line dials an extension that its own phone rings for, such as a team its user belongs to, the plan leaves that phone out and lists it in `skipped` with the reason `caller_phone`. The user's other phones still ring.

### A deactivated organisation

When an organisation is deactivated (`DELETE /organisations/{id}`, or `status` set to `deactivated`), its lines cannot call outside numbers: `resolve` refuses the call with `organisation_deactivated`. 999 and 112 still go out. Calls between extensions and calls in still ring.

Only `deactivated` does this. A `suspended` or `provisional` organisation's phones work as before.

The lines stay registered and the phones still fetch their settings, so an emergency call can still be made. Call control answers a refused call with SIP 480, as it does for `charge_unpaid`. It records the call, at no charge.

### A call that belongs to an agent

A number rings an extension or an agent, never both. So a `number` request has three answers:

- The number rings an extension: the plan of that extension, as above.
- An agent listens on the number: `action: "agent"`. The plan has `planId`, `ttlSeconds`, `organisationId` and the `agent` block, and nothing else.
- Neither: `refuse` with `number_not_routed`.

The agent answer does not need the phone system. It is given for every organisation, whatever its capabilities and whatever `PBX_RELEASE` is.

Call control hands the call to the Pipecat worker beside the engine that holds it. [voiceblender-integration.md](voiceblender-integration.md#behind-call-control) has that request.

The number is found by number and trunk, with the same lookup the agent workers use (`GET /agent-db/phone-endpoints?number=&trunkId=`). So call control and a worker find the same agent for the same call. `trunkId` may hold several candidates separated by `;`, as it may there.

A `registration` request is for a call that arrives from a registration and not on a trunk. `registrationId` is the id of the registration (the value of the call's `X-Aplisay-PhoneRegistration` header). The answer follows the workers' order:

1. The agent that listens on the registration.
2. If there is none and the registration is a trunk, the agent that listens on `calledNumber` on that trunk.

A number is never looked up without a trunk. The request names none: the trunk is the registration's own. A call from a registration to an extension is not supported yet.

The four refusals below carry no `organisationId`. Call control records a refused call that names an organisation as a phone system call, and these are not phone system calls.

| `reason` | Meaning |
|---|---|
| `agent_not_available` | The instance is gone, or its agent is |
| `runtime_not_supported` | The agent runs on a runtime that call control cannot hand a call to. Only `pipecat` is supported |
| `registration_not_found` | No registration has that id. The SIP account of a desk phone line is not a registration |
| `registration_not_routed` | No agent listens on the registration, or on the number called on it |

A phone system call is one `calls` row with no agent, model name `telephony:pbx-call` and platform `pbx`. Every call and answered leg writes usage when it ends: a leg out to an outside number is charged, and the rest is written at nothing. Each extension but a `connection` has a monthly charge. See [billing](billing-calls-from-usage.md#the-phone-system).

## Who sees calls

The calls routes (`GET /calls`, `GET /calls/{callId}`, `/linked`, `/logs`, `/invocation-log` and `/recording`) apply one rule to phone system calls. Agent calls show as before.

| Who | Sees |
|---|---|
| A principal with `call: readOthers`: the `owner`, `textOnly`, `audioOnly`, `orgAdmin`, `superAdmin` and `support` roles | Every call in its scope |
| Anyone else, such as a `member` | Agent calls, and a phone system call that involves the directory person linked to their login |

A phone system call involves a person when:

- it was made to an extension the person owns (the extension's `entryId` is the person);
- it was placed from one of the person's phones, or from a line of an extension the person owns;
- its answered leg rang for the person. On a shared extension, such as a team's, only the member who answered sees the call, from the moment the leg answers. A mobile that waits for its key counts once the key comes. A call to a shared extension that nobody answered shows only to those who see every call.

A login with no linked person sees no phone system calls. A leg row shows when its call does. A recording or a transcript shows to whoever sees its call: otherwise the recording route answers 404, and the transcript and invocation log routes answer an empty list. `POST /agents/{id}/invoke` with a `callId` answers 404 for a call its caller cannot see, as for a call that does not exist.
