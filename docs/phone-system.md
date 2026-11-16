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

Taking the capability away deletes nothing. Calls are refused and the routes answer 403 until it is given back.

An organisation without the capability still has the directory, and extensions of type `connection`: numbers on its own phone system, reached through one of its connections.

`GET /me` returns `organisation.capabilities`, so a front end can decide which pages to show without another request.

### Brands

A brand is a label on an organisation that says which front end its customers use. A platform operator creates a brand and sets the capabilities a new organisation of that brand starts with:

```shell
curl -s -X PUT -H "$H" -H 'Content-Type: application/json' $API/brands/acme \
  -d '{"name":"Acme","defaultCapabilities":["phoneSystem"]}'
```

A change to the defaults applies to organisations created afterwards. It does not touch existing ones.

`scripts/provision-brand-service.mjs --brand acme` mints a service key for that brand. The key may create organisations, which take its brand and the brand's defaults, list and read the organisations of its brand, and set their capabilities. It reaches no organisation of another brand. An organisation's brand is fixed once set. A platform operator may give a brand to an organisation that has none, with `PATCH /organisations/{id}`.

The owner of an organisation may read and change its phone system settings (`/organisations/{id}/phone-system`), for its own organisation only. It cannot change the organisation's status.

## How it fits together

An admin sets three things:

1. Which extensions a person belongs to. A person's own extension is the one on their directory entry. A team's or service's extension is shared, and people are added to it as members.
2. Which phones ring for a person (`/phones/{id}/people`).
3. What type each extension is, with its settings.

Everything else is worked out. For each desk phone the platform takes the people it rings for, puts each person's own extension first, then their shared extensions in each person's key order, and gives each one a key. If there are more extensions than the phone has lines, the last key becomes an overflow line that takes calls for all the rest.

A phone rings for at most one person fewer than it has lines, and a one-line phone for one. More is refused with `phone_too_small`.

A line is known by its phone and its extension. While that pair lasts, the line keeps its SIP account and its line number, even when its key moves. Lines are read-only: `GET /phones/{id}/lines`. `GET /phones/{id}/changes` records why a phone's keys changed.

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

Until phones are provisioned automatically, `GET /phones/{phoneId}/lines/{lineId}/credentials` shows the SIP account of one line so a phone can be set up by hand. It needs `phone:provision` and each read is written to the audit log.

## Settings

| Variable | Use |
|---|---|
| `PBX_RELEASE` | See above |
| `PBX_REGISTRAR_DOMAIN` | The host name desk phones register to. It is the digest realm of every line's SIP account, so it cannot change once lines exist. Unset means `REGSERVER_REGISTRAR` |
| `CALLCTL_SHARED_TOKEN` | The token call control sends as `x-callctl-token` |

## Internal routes for call control

These are under `/api/agent-db/pbx`. They take `x-callctl-token` only. The workers' `x-shared-token` does not open them, and the call control token opens nothing else. With `CALLCTL_SHARED_TOKEN` unset they are closed.

| Route | Use |
|---|---|
| `POST /agent-db/pbx/resolve` | What should this call do? The body is `{ callId, request }`. `request.kind` is `number` (a call in on a trunk: `calledNumber`, `trunkId`, `callerId`), `registration` (a call in from a registration: `registrationId`, `calledNumber`, `callerId`), `dialled` (digits from a line: `fromEndpoint`, `digits`), `extension` or `line` (follow-ups about a call in progress) |
| `POST /agent-db/pbx/outbound-authorisation` | May this leg to an outside number be placed? The same policy the agent workers use. The caller must fail closed |
| `POST /agent-db/pbx/calls` | Record a call, or an answered leg of one (`parentId`). The caller chooses the id, so a write sent twice is one row |
| `POST /agent-db/pbx/calls/{callId}/events` | Things that happened on a call and are not rows of their own, such as a phone that rang and was not answered |
| `POST /agent-db/pbx/calls/{callId}/end` | The call or leg has ended |

`resolve` always answers 200 with a plan for a request it could decide. `action` is one of:

| `action` | Meaning |
|---|---|
| `ring` | Ring the legs of `ring.steps`, in order. A leg names a line of a phone (`lineId`, `lineNumber`, `key`, the SIP `endpoint`, and what to `display`) or an outside number. When the last step ends unanswered, do what `noAnswer` says |
| `outside` | A call from a line to an outside number. `outside.presentNumber` is the number to show |
| `emergency` | A 999 or 112 call. Always answered, whatever the organisation's switches |
| `connection` | Send the digits to the organisation's own phone system |
| `agent` | Hand the call to an agent. `agent` names it: `instanceId`, `agentId` and `runtime`. Today only for a call that goes straight to an agent (see below). An agent as an extension, or as a destination of one, is a later release |
| `forward` | Later releases |
| `refuse` | The call cannot be routed. `reason` says why, for example `number_not_routed` or `phone_system_disabled` |

The plan applies what the directory knows: members, phones, lines, do-not-ring rules, and that an outside number rings only for its own person's own extension. It does not know whether a phone is busy or connected. Call control filters the legs by that.

A phone never rings for a call it places. When a line dials an extension that its own phone rings for, such as a team its user belongs to, the plan leaves that phone out and lists it in `skipped` with the reason `caller_phone`. The user's other phones still ring.

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

A phone system call is one `calls` row with no agent, model name `telephony:pbx-call` and platform `pbx`. These calls write no usage yet.
