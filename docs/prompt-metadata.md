# Stating call facts in the prompt (`promptMetadata`)

> Status: supported on **every interactive-audio handler** — `ultravox:`,
> `livekit:` and `pipecat:` — and stored (but unused) on `text:` agents, which
> have no call metadata to resolve. No model capability flag is involved: the
> value is resolved by the platform and reaches the model as ordinary prompt
> text, so it works on any model.

An agent can declare call metadata that is **stated to the model in its system
prompt**, instead of leaving the model to fetch it with a `get_metadata` tool
call:

```jsonc
{
  "modelName": "pipecat:ultravox/ultravox-v0.7",
  "prompt": "You are the booking assistant for HomeTrades…",
  "promptMetadata": [
    { "description": "The current date/time is", "from": "aplisay.dateTime" },
    { "description": "The number this caller is calling from is", "from": "aplisay.callerId" }
  ]
}
```

Every call, each entry is resolved and appended to the agent's prompt:

```
You are the booking assistant for HomeTrades…

Call context (current facts about this call):
The current date/time is Tuesday 2026-07-28 10:32 Europe/London
The number this caller is calling from is +447700900123
```

## Why not just use the `get_metadata` tool?

Both mechanisms read the same call metadata. They differ in *when* the model
learns the value:

| | `promptMetadata` | `get_metadata` builtin |
|---|---|---|
| Model sees it | From its first utterance, always | Only after it decides to call the tool |
| Reliability | Guaranteed — it's in the prompt | Depends on the model remembering |
| Turn cost | None | A tool round-trip; on realtime providers this **freezes the conversation** while it runs |
| Freshness | Resolved at call start (and again after each handover) | Resolved at the moment of the call |

Use `promptMetadata` for facts the agent must **reason with from the start** —
today's date above all. Use `get_metadata` for values needed only occasionally,
or that may change during a long call.

## Entry shape

```jsonc
{ "description": "The current date/time is", "from": "aplisay.dateTime" }
```

| Field | Required | Meaning |
|---|---|---|
| `from` | yes | Dot-path into the call metadata |
| `description` | no | Sentence fragment placed **before** the value |

Write `description` so that `<description> <value>` reads as a complete
statement of fact — the model reads it as a sentence, not a key/value pair.
With no `description`, the bare value is stated on its own line.

At most **20** entries; `description` is capped at 200 characters and each
rendered value at 500.

## Available `from` paths

`from` resolves against exactly the same metadata that a function parameter's
`{"source": "metadata", "from": …}` reads, so anything addressable there works
here:

| Path | Value |
|---|---|
| `aplisay.dateTime` | Current date/time, e.g. `Tuesday 2026-07-28 10:32 Europe/London` — weekday included so the model can reason about "next Tuesday". Computed **live**; timezone from `AGENT_TIMEZONE` (default `Europe/London`) |
| `aplisay.callerId` | Caller's number (`WebRTC` for browser sessions) |
| `aplisay.calledId` | Number the caller dialled |
| `aplisay.callId` | Platform call id |
| `aplisay.modelName` | Model handling the call |
| *anything you seed* | Keys placed in instance metadata at call creation — CRM lookups, account tier, agent-specific context |


## Rules

- **Absent values are omitted.** An entry whose value is missing, `null` or
  blank produces *no line at all* — never `undefined`. An optional fact that
  isn't there must not become a statement the model would then treat as true.
  A declaration where nothing resolves leaves the prompt byte-identical.
- **`aplisay.dateTime` is computed live** at prompt-composition time. A value
  actually seeded at that path wins, which is what makes date behaviour
  testable.
- **Objects and arrays** render as compact JSON, so `{"from": "crm.contact"}`
  yields `{"name":"Bob"}`. Long values are truncated with `…`.
- **Resolved per session.** After a `transfer_agent` handover the *incoming*
  agent's own declaration is resolved against the same call — each agent in a
  set states its own facts, and a set can mix agents that declare
  `promptMetadata` with agents that don't.

## Worked examples

**Booking agent** — with the date stated, the
agent computes a real `from` date for an availability search instead of guessing:

```jsonc
"promptMetadata": [
  { "description": "The current date/time is", "from": "aplisay.dateTime" }
]
```

**Recognising a returning caller** — pair with a CRM lookup seeded into instance
metadata at call creation:

```jsonc
"promptMetadata": [
  { "description": "The caller is calling from", "from": "aplisay.callerId" },
  { "description": "Our records show this customer as", "from": "crm.accountName" },
  { "description": "Their support tier is", "from": "crm.tier" }
]
```

If the CRM lookup found nothing, those last two lines simply don't appear and
the agent greets an unknown caller normally — no "the customer is undefined".

**Value with no description** — when the fact is self-describing:

```jsonc
"promptMetadata": [
  { "from": "briefing.todaysPromotion" }
]
```

## Where it applies

`promptMetadata` is a top-level Agent property, so it is set the same way
everywhere an agent is defined:

- `POST /agents` and `PUT /agents/{agentId}`
- agent-set members in `POST /agent-sets` / `PUT /agent-sets/{agentSetId}` —
  it round-trips through GET like any other member field
- it survives publish/restore in the versioning paths

Malformed declarations are rejected at create/update time with a message naming
the offending entry, so a broken declaration can never reach a live call.

## IMPORTANT SECURITY/PRIVACY NOTE

Everything you promote from the metatdata to the prompt using this feature unconditionally becomes part of the context visible to the LLM.

For privacy, confidentiality and security reasons, use this pattern very carefully. 
Anything that an LLM can see in the context, it may reveal or act on externally. It may reveal it in conversation with the user or place in arguments to external tools calls. 
The data will also be processed and reside on the LLM providers' systems and depending on your contractual arrangements may be used by them to train future iterations of the model or even be disclosed to other users.

You may be able to discourage the LLM from leaking this information by prompting, but the safest way to guarantee that confidential data will not be used inappropriately by an LLM is to ensure it never sees it.

Using this feature to expose confidential data in the prompt and then having the LLM later use this in generated tools calls is therefore an anti-pattern that should be avoided.


| Usage | Reccomended | How/Alternatives |
| ----- | ------------- | ----------------- |
| Add date and time to give model a context for date based requests | **Yes** - this is an intended and safe use case | Use `aplisay.dateTime` |
| Add caller number so agent LLM can use it to do a CRM lookup later in the conversation | **No** - this is not safe as it may leak the callers number to places we don't intend to share it with | Make the CRM lookup tools call with the caller number parameter directly from `metadata.aplisay.callerId` so that it goes to the CRM lookup tool directy out of band from the LLM context. |
| Give the LLM an auth key to pass as a generated parameter to an external tools call | **No** - this is not safe as it may leak the auth key | Make the tools call with the auth key parameter directly on the `keys` array |