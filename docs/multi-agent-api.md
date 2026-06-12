# Multi-Agent Features: Agent-to-Agent Transfers, Subagents, and Agent Sets

This document describes how to build *teams* of agents using the LLM Agent API: handing a live call from one agent to another mid-conversation, delegating work to headless text agents invoked like function calls, and managing a whole group of agents from a single JSON document. It is written for API users; for implementation internals see [`agent-sets-and-subagents.md`](./agent-sets-and-subagents.md).

## Overview

Three features work together:

1. **Agent-to-agent transfers** — the builtin `transfer_agent` platform function hands a live call over to a different agent definition. The caller stays on the same call; the new agent's prompt and tools take over, optionally carrying the conversation history across.
2. **Text agents and subagents** — a new agent `type` of `text` defines a headless agent with no audio session. A voice agent invokes it through the builtin `subagent` platform function exactly as it would call any other tool; the text agent runs its own LLM/tool loop and returns its output by calling a definitive builtin `result` function.
3. **Agent sets** — `POST /agent-sets` creates a group of agents from one document. Members reference each other with shortform labels (`label:sales`) instead of IDs; the platform resolves these to real agent IDs for you and lets you update or delete the whole group as a unit.

A typical composition: a front-desk agent answers every call, hands callers to a sales or support specialist with `transfer_agent`, and any of them can ask a back-office `text` agent to look something up via `subagent` — all defined and deployed in one `POST /agent-sets` call.

### Where these features work

| Capability | `livekit:` models | `pipecat:` models | `jambonz:` | `ultravox:` | `text:` models |
|---|---|---|---|---|---|
| `transfer_agent` (hand over a live call) | ✅ ¹ | ✅ ² | ❌ | ❌ | n/a |
| `subagent` (call a text agent) | ✅ | ✅ | ❌ | ❌ | ✅ (nested, depth-limited) |
| `result` / invokable via `/invoke` | n/a | n/a | n/a | n/a | ✅ |

¹ ² Ultravox realtime models cannot change prompt or tools mid-call (one-shot session creation), so `transfer_agent` on them always uses the **full-stack handover** (new session, child call record) even when the model string is unchanged — see "What happens on a transfer" below. On Pipecat, full handover works on websocket SIP gateway legs (FreeSWITCH / sipbridge / voiceblender) and browser WebRTC sessions; Daily legs refuse it.

Saving an agent that uses one of these builtins on an unsupported model is rejected at create/update time with a clear validation error.

---

## 1. Agent-to-agent transfers

### The `transfer_agent` function

Add a builtin function with `platform: "transfer_agent"` to a voice agent:

```json
{
  "name": "transfer_to_sales",
  "implementation": "builtin",
  "platform": "transfer_agent",
  "description": "Hand the caller over to the sales agent when they want to discuss pricing or buying.",
  "input_schema": {
    "properties": {
      "agent": {
        "type": "string",
        "source": "static",
        "from": "32555d87-948e-48f2-a53d-fc5f261daa79"
      },
      "includeHistory": {
        "type": "boolean",
        "source": "static",
        "from": true
      },
      "summary": {
        "type": "string",
        "description": "One or two sentences for the next agent about who the caller is and what they need."
      }
    }
  }
}
```

As with every builtin, the function `name` and `description` are yours to choose — they are what the LLM sees and reasons about. The `platform` value selects the behaviour.

**Parameters:**

| Parameter | Source | Required | Description |
|---|---|---|---|
| `agent` | `static` or `metadata` — **never `generated`** | Yes | The target agent's ID. Within an [agent-set document](#3-agent-sets) a static value may be a `label:<label>` reference. The target must be an `interactive-audio` agent belonging to your organisation; this is checked when you save the agent and again at call time. |
| `includeHistory` | `static` | No (default `false`) | When `true`, the transcript of the conversation so far is carried into the new agent's context. When `false` or omitted, the new agent starts clean and is explicitly instructed to disregard any prior context. |
| `summary` | `generated` | No | A handover note the transferring LLM composes at call time. Delivered to the new agent alongside its prompt regardless of the `includeHistory` setting. |

The same anti-fraud rule as the `transfer` function's `number` applies: the target can never be chosen freely by the LLM. It is either fixed in the agent definition (`static`) or resolved from per-call metadata (`metadata`, including `metadata.toolsCalls.…` paths on handlers with dynamic metadata) — so an agent designer always controls the set of reachable agents.

### What happens on a transfer

The platform picks one of two handover modes automatically:

**In-place handover** — used when the target agent has the **same `modelName`** as the
running session and the stack can apply the swap. The new agent's **prompt and
functions** replace the old agent's inside the live session: same call record, same
model, same voice. This is the cheapest, most seamless mode — the caller hears a brief
pause and a different agent speaks.

**Full-stack handover** — used when the target agent's **model string differs** (a
different provider, voice stack, or model id), and on Ultravox realtime models (which
cannot change prompt or tools after call creation, so even a same-model transfer
restarts). The platform stops the running agent stack and starts the target agent's own
stack — its model, voice and tools — on the same live call (same room / SIP leg; the
caller never leaves). Because the model changes:

- a **new call record is created with the original call as `parentId`** (the same
  lineage convention as bridged telephone transfers), so usage, transcripts and
  recordings are attributed to the agent + model that actually handled each segment;
- the original call record ends with a status of the form
  `transferred to agent <id>, continued as call <child-id>`;
- transcripts from the handover onward log against the child call.

Prompt-only (in-place) switches deliberately do **not** create a child record.

Common to both modes:

- The audio connection is uninterrupted — the caller stays on the same call throughout.
- The new agent speaks next, so write its prompt to introduce itself on taking over.
- The progress log (websocket / transaction log) records an `inject` entry of the form
  `Call transferred to agent <name>` so monitoring UIs can show the handover.
- Transfers chain: the incoming agent's own `transfer_agent` functions work, so a caller
  can be passed A → B → C, or back to A — each model change adds another child call.

Full-stack handover constraints:

- The target agent's model must run on the **same worker** as the live session: a
  LiveKit room can only hand over to `livekit:` models, a Pipecat call to `pipecat:`
  models. (The room or SIP leg is owned by that worker; use ordinary call transfer to
  move a call between platforms.)
- On Pipecat, full handover is supported on the websocket SIP gateways
  (FreeSWITCH / sipbridge / voiceblender) and on browser WebRTC sessions; Daily
  legs, consultation legs, and calls with an engaged media relay refuse it with
  a `FAILED` result.
- Call recording does not follow a full handover on LiveKit (the recording covers up to
  the handover); on Pipecat each call record segment records separately.
- If the new stack cannot be started (e.g. the target agent is at its concurrency
  limit), the handover aborts with a `FAILED` result and the current agent keeps the
  call.

### History and the handover summary

You have three levels of context carry-over, from cheapest to richest:

1. **Nothing** (`includeHistory: false`, no `summary`): the new agent starts from scratch — appropriate when the first agent is a pure switchboard.
2. **Summary only**: the transferring LLM writes one or two sentences. This is usually the sweet spot — the new agent gets "Caller is Mrs Jones, account 4471, wants to dispute an invoice" without wading through the verbatim transcript.
3. **Full history** (`includeHistory: true`): the entire conversation so far is included in the new agent's context, formatted as a caller/agent transcript. Use when the new agent genuinely needs detail the summary might lose. Note that on realtime speech-to-speech providers the *audio-side* conversation state cannot be wiped, so `includeHistory: false` on those models is enforced by instruction ("treat this as a fresh conversation") rather than by hard isolation — don't rely on it to hide earlier conversation content from the model.

### Failure behaviour

If the handover cannot be performed (target agent deleted, wrong type, unsupported model), the function returns a `FAILED` result to the *current* agent, which keeps the call and can apologise / try something else. Design prompts so the transferring agent reacts gracefully to a failed handover.

---

## 2. Text agents and subagents

### Creating a text agent

A text agent is a normal agent with a `text:`-prefixed model name. The `type` field is inferred (`"text"`) from the model name, so you can omit it:

```http
POST /api/agents
```

```json
{
  "name": "Weather researcher",
  "modelName": "text:openai/gpt-4o",
  "prompt": "You are a weather research agent. Your task input contains a city name. Use get_lat_lon to find coordinates, get_weather for current conditions, then call report_weather exactly once with a short spoken-English report naming the city and the current temperature.",
  "functions": [
    { "...": "ordinary rest/stub functions work exactly as on voice agents" },
    {
      "name": "report_weather",
      "implementation": "builtin",
      "platform": "result",
      "description": "Deliver the finished weather report. Call exactly once when you have the answer.",
      "input_schema": {
        "properties": {
          "report": {
            "type": "string",
            "description": "Short spoken-English weather report",
            "required": true
          }
        }
      }
    }
  ]
}
```

Key points:

- **Model names**: `text:openai/…`, `text:anthropic/…`, `text:gemini/…`, `text:groq/…`. `GET /models` lists the text models available on your deployment.
- **No audio options**: `tts`, `stt`, voices and greetings are meaningless for text agents and should be omitted. Text agents cannot be activated with `listen`.
- **The `result` function** (builtin, `platform: "result"`) is the agent's *output contract*: its `input_schema` describes the structure you want back, and the arguments the agent passes when it calls it become the invocation result. An agent with no `result` function falls back to returning its first plain-text reply as `{ "text": "…" }` — fine for casual use, but defining a `result` schema gives you reliable, structured output.
- Text agents can use `rest` and `stub` functions, the `metadata` builtin, and may even call their own `subagent` functions (nesting is limited to 3 levels).

### Invoking a text agent directly

Useful for testing, and as a lightweight "structured task" API in its own right:

```http
POST /api/agents/{agentId}/invoke
```

```json
{
  "input": { "city": "Cambridge" },
  "metadata": { "myapp.requestId": "abc-123" }
}
```

Response:

```json
{
  "result": { "report": "In Cambridge it is currently twelve degrees Celsius with light cloud." },
  "complete": true,
  "transcript": [ { "agent": "…" }, { "function_calls": [ "…" ] } ]
}
```

- `result` — the arguments the agent passed to its `result` function (or the `{ "text": … }` fallback).
- `complete` — `true` when the agent terminated by calling its `result` function; `false` if it hit the turn limit first (the best available text is still returned).
- `transcript` — the internal turns of the invocation, for debugging.

Invocations are bounded: at most 10 LLM round trips and a wall-clock timeout (60 s by default; a timeout returns HTTP 504).

### Calling a text agent from a voice agent (`subagent`)

On the voice agent, add a builtin function with `platform: "subagent"`:

```json
{
  "name": "ask_weather_service",
  "implementation": "builtin",
  "platform": "subagent",
  "description": "Ask the weather research service for the current weather in a city. Returns a short spoken-English report.",
  "input_schema": {
    "properties": {
      "agent": {
        "type": "string",
        "source": "static",
        "from": "<weather-researcher-agent-uuid>"
      },
      "city": {
        "type": "string",
        "description": "The city to get the weather for",
        "required": true
      }
    }
  }
}
```

- `agent` follows the same rules as `transfer_agent`'s target: `static` or `metadata`, never `generated`; must be a **`text`** agent in your organisation; `label:` references work inside agent-set documents.
- Every other (`generated`) parameter is forwarded to the text agent as its **task input** — the example above delivers `{ "city": "London" }` as the subagent's opening message.
- The function result returned to the calling LLM is the subagent's `result` payload (e.g. `{"report": "…"}`), which the voice agent can read out or act on.

Because a subagent invocation is a real multi-turn LLM/tool run it can take ten seconds or more. Prompt the voice agent to manage the silence ("let the caller know you are checking"), and consider the `maxDuration` of the call when chaining several lookups.

### Why a subagent rather than more tools?

You can of course give the voice agent the weather tools directly. Subagents earn their keep when:

- the task needs **multi-step reasoning over tools** that would bloat the voice agent's prompt and tool list (and its latency on *every* turn);
- you want **one specialist maintained in one place** and shared by many voice agents;
- the work should produce a **structured result** (the `result` schema) rather than free conversation;
- you want to **test the capability in isolation** via `POST /agents/{id}/invoke`.

---

## 3. Agent sets

Agent sets let you create, version, and delete a whole team in single API calls, and — crucially — let members reference each other *before* any of them has an ID.

### Endpoints

| Method and path | Purpose |
|---|---|
| `POST /api/agent-sets` | Create a set and all member agents from one document |
| `GET /api/agent-sets` | List your sets (summary: member id/label/name/model/type) |
| `GET /api/agent-sets/{id}` | Full set with complete member definitions (`keys` never returned) |
| `PUT /api/agent-sets/{id}` | Update the set as a group (see semantics below) |
| `DELETE /api/agent-sets/{id}` | Delete the set **and all member agents** |

### The set document

```json
{
  "name": "Front office",
  "description": "Triage, sales, and a research subagent",
  "agents": [
    {
      "label": "triage",
      "name": "Triage",
      "modelName": "livekit:ultravox/ultravox-70b",
      "prompt": "You answer the phone and work out what the caller needs…",
      "functions": [
        {
          "name": "transfer_to_sales",
          "implementation": "builtin",
          "platform": "transfer_agent",
          "description": "Hand over to sales",
          "input_schema": {
            "properties": {
              "agent": { "type": "string", "source": "static", "from": "label:sales" },
              "includeHistory": { "type": "boolean", "source": "static", "from": true },
              "summary": { "type": "string", "description": "Handover note for sales" }
            }
          }
        },
        {
          "name": "ask_researcher",
          "implementation": "builtin",
          "platform": "subagent",
          "description": "Ask the research agent a product question",
          "input_schema": {
            "properties": {
              "agent": { "type": "string", "source": "static", "from": "label:researcher" },
              "question": { "type": "string", "required": true, "description": "What to research" }
            }
          }
        }
      ]
    },
    {
      "label": "sales",
      "name": "Sales",
      "modelName": "livekit:ultravox/ultravox-70b",
      "prompt": "You are the sales agent. You take over live calls from triage…"
    },
    {
      "label": "researcher",
      "name": "Researcher",
      "modelName": "text:openai/gpt-4o",
      "prompt": "You answer product questions concisely…",
      "functions": [
        {
          "name": "deliver_answer",
          "implementation": "builtin",
          "platform": "result",
          "description": "Deliver your answer",
          "input_schema": {
            "properties": {
              "answer": { "type": "string", "required": true, "description": "The answer" }
            }
          }
        }
      ]
    }
  ]
}
```

### Labels and reference fixup

- Every member needs a `label`, unique within the set (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`). Members are otherwise ordinary agents: they show up in `GET /agents`, you activate listeners on them individually (`POST /agents/{memberId}/listen`), and they can be fetched and updated one at a time if you really want to.
- In `transfer_agent` and `subagent` functions, a static `agent` value of `label:<label>` refers to another member of the same set. On create/update the platform **rewrites it to the member's real agent ID** and records the original label next to it as `fromLabel`:

  ```json
  "agent": {
    "type": "string",
    "source": "static",
    "from": "0b1c2d3e-…-resolved-uuid",
    "fromLabel": "sales"
  }
  ```

- Because `fromLabel` is preserved, a document read back with `GET /agent-sets/{id}` can be edited and `PUT` straight back: labelled references are always re-resolved against the membership in the incoming document. You never have to manage member UUIDs by hand.
- References to agents *outside* the set are also allowed — use the plain agent UUID instead of a label.

### Update and delete semantics

`PUT /agent-sets/{id}` reconciles by label:

- a label that already exists → that member is **updated in place, keeping its agent ID** — live listeners attached to it stay attached;
- a new label → a new member agent is created;
- a label missing from the document → that member agent is **deleted**.

The whole operation (create and update alike) is **transactional**: one bad member or one unresolvable reference fails the entire request with HTTP 400 and leaves nothing changed.

`DELETE /agent-sets/{id}` removes the set and every member agent. If members have active listeners, delete those first (as you would before deleting any agent).

### Validation rules

These are enforced on `POST /agents`, `PUT /agents/{id}`, and throughout agent-set operations:

| Rule | Error you'll see |
|---|---|
| `transfer_agent`/`subagent` `agent` parameter must be `static` or `metadata` | `…cannot be generated, must be either "static" or "metadata"` |
| A static `agent` value must be a UUID (or `label:` inside a set document) | `…must be an agent UUID (labels are only valid within an agent-set document)` |
| A `label:` reference must name a member of the set | `…references label "x" which is not a member of this agent set` |
| Static targets must exist and be accessible to you | `…references agent <id> which does not exist or is not accessible` |
| `transfer_agent` must target an `interactive-audio` agent; `subagent` must target a `text` agent | `…must target a <type> agent, but <id> is type <type>` |
| The handler must support the builtin (see the support matrix) | `Model <name> does not support agent-to-agent transfer…` / `…subagent invocation…` |
| `result` is only valid on `text` agents | `The result platform function is only valid on agents of type "text"` |
| Duplicate / malformed member labels | `Duplicate agent label "x" in agent set` / label format error |

## See also

- [`call-transfers.md`](./call-transfers.md) — transferring calls to *phone numbers* (blind and consultative), including REFER vs bridging mechanics. `transfer_agent` complements rather than replaces these: use `transfer` to reach humans and external systems, `transfer_agent` to move between AI agents.
- [`mcp-servers.md`](./mcp-servers.md) — giving agents remote MCP servers (`mcpServers`, a sibling of `functions`). Agent-set members may carry `mcpServers` like any other agent field.
- [`agent-sets-and-subagents.md`](./agent-sets-and-subagents.md) — engineering notes on the implementation of the features in this guide.
- [`tool-call-chaining-metadata-priming.md`](./tool-call-chaining-metadata-priming.md) — sourcing function parameters (including `agent` targets) from earlier tool results via `metadata.toolsCalls`.
