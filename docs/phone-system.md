# The phone system: directory, phones and lines

This page describes the part of the API that lets desk phones register to the platform and ring for people. It is under development. It is off for every organisation until an operator switches it on.

## What is here today

- **The directory.** People, teams and services, and their extensions. Every organisation has one.
- **Phones.** Desk phones and outside numbers such as mobiles, and the people each one rings for.
- **Lines.** The keys of a desk phone, worked out by the platform. Each line has its own SIP account.
- **Number routing.** A number can ring an extension in place of an agent.
- **Internal routes for call control.** A separate service decides what each call does by asking this API.

Not here yet: the service that carries the calls, phone provisioning, hunt groups, queues, agents inside these calls, and charging.

## The two switches

| Switch | Where | What it does |
|---|---|---|
| The `phoneSystem` capability | `PUT /organisations/{id}/capabilities` with `{ "capabilities": ["phoneSystem"] }`. Needs `organisation:setCapabilities`, which only a platform operator holds | Switches the phone system on for one organisation. Without it every phone system request answers 403 with code `phone_system_disabled` |
| `PBX_RELEASE` | An environment variable of the API server | Which extension types and phone kinds the deployment accepts. Unset means `1`: types `connection` and `ring_all`, phones `deskphone` and `external` |

Taking the capability away deletes nothing. Calls are refused and the routes answer 403 until it is given back.

An organisation without the capability still has the directory, and extensions of type `connection`: numbers on its own phone system, reached through one of its connections.

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
| `POST /agent-db/pbx/resolve` | What should this call do? The body is `{ callId, request }`. `request.kind` is `number` (a call in: `calledNumber`, `trunkId`, `callerId`), `dialled` (digits from a line: `fromEndpoint`, `digits`), `extension` or `line` (follow-ups about a call in progress) |
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
| `forward`, `agent` | Later releases |
| `refuse` | The call cannot be routed. `reason` says why, for example `number_not_routed` or `phone_system_disabled` |

The plan applies what the directory knows: members, phones, lines, do-not-ring rules, and that an outside number rings only for its own person's own extension. It does not know whether a phone is busy or connected. Call control filters the legs by that.

A phone system call is one `calls` row with no agent, model name `telephony:pbx-call` and platform `pbx`. These calls write no usage yet.
