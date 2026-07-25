# Agent Sets, Agent-to-Agent Transfers, and Text Subagents

> Status: feature branch `feature-agent-set`, validated end-to-end on the LiveKit
> and Pipecat workers; see the support matrix below.
>
> **API users**: this page is engineering notes. The user-level guide with full
> request/response examples is [`multi-agent-api.md`](./multi-agent-api.md).

Three related features that let a single phone number or room front a *team* of
agents rather than one monolithic prompt:

1. **Agent-to-agent transfers** — a live call is handed over from one agent
   definition to another mid-call, with or without the conversation history.
2. **Agent sets** — a group of agents is created, updated and deleted as a
   single unit from one JSON document, using shortform labels for the
   references between members.
3. **Text subagents** — a new headless `text` agent type which a voice agent
   invokes like a function; the text agent does its work (its own LLM loop and
   tool calls) and returns its output by calling a definitive `result`
   function.

---

## 1. Agent-to-agent transfers (`transfer_agent` builtin)

A new builtin platform function, validated like `transfer` but targeting an
*agent* rather than a phone number:

```json
{
  "name": "transfer_to_sales",
  "implementation": "builtin",
  "platform": "transfer_agent",
  "description": "Hand the caller to the sales agent when they want to buy",
  "input_schema": {
    "type": "object",
    "properties": {
      "agent": { "type": "string", "source": "static", "from": "<agent-uuid>" },
      "includeHistory": { "type": "boolean", "source": "static", "from": true },
      "summary": {
        "type": "string",
        "description": "One or two sentences for the next agent about the caller and what they need"
      }
    }
  }
}
```

Parameters:

* `agent` (required): the target agent's UUID. Must be `static` or `metadata`
  sourced — never `generated`, for the same anti-abuse reasons as the
  `transfer` function's `number`. Inside an agent-set document this can be a
  `label:<label>` reference (see below). The target must be an
  `interactive-audio` agent in the same organisation.
* `includeHistory` (optional, `static`): when `true` the transcript of the
  conversation so far is carried into the new agent's context. When omitted or
  `false` the new agent starts clean and is explicitly told to disregard prior
  context.
* `summary` (optional, `generated`): the transferring LLM composes a short
  handover note which is delivered to the new agent alongside its prompt.

Runtime behaviour (LiveKit worker): the tool resolves the target definition
through the internal agent API (with a same-organisation guard), builds the new
agent's tools, and performs an SDK-level agent handoff (`llm.handoff()`) on the
live session. The call record continues uninterrupted; the progress log gets an
`inject` entry noting the handover. Chained transfers (A → B → C, or back to A)
work because each handed-over agent's own `transfer_agent` functions are wired
the same way.

Runtime behaviour (Pipecat worker): the same flow, implemented as an in-place
pipeline swap (`CallSession._apply_agent_transfer`): the target definition is
fetched with the same organisation guard, the LLM service's tool callbacks are
re-registered, and the pipeline is sent `LLMUpdateSettingsFrame` (new system
instruction) + `LLMMessagesUpdateFrame` (fresh context) + `LLMSetToolsFrame`
(new tool schemas) + `LLMRunFrame` so the incoming agent takes the next turn.
The outgoing agent's tool-result run is suppressed on success so the two
agents don't talk over each other.

### Handover modes

The runtime picks one of two modes per transfer:

* **In place** (same `modelName`, stack supports the swap): prompt + tools are
  replaced inside the live session (LiveKit `llm.handoff()`; Pipecat context /
  settings / tools frames). Same call record, same model and voice.
* **Full-stack restart** (model string differs, or Ultravox realtime which can
  swap neither prompt nor tools after call creation): the running agent stack
  is stopped and the target agent's own stack — model, voice, tools — starts
  on the same live call. A **child call record** is created with
  `parentId` = the original call (the bridged-transfer lineage convention);
  the original ends with `transferred to agent <id>, continued as call <id>`,
  and transcripts/usage from that point log against the child. LiveKit:
  the new `AgentSession` is started into the same room with the close/teardown
  handlers suppressed during the swap (`agentHandoverInProgress`), and the
  worker's transcript/teardown call pointer is repointed
  (`setActiveAgentCall`). Pipecat: the old pipeline task is cancelled with the
  shared connection's disconnect suppressed, a fresh transport is rebuilt
  around the same connection (`FastAPIWebsocketTransport` over the same
  websocket + serializer; `SmallWebRTCTransport` over the same peer
  connection, with a manual client-connected kick since the peer's
  "connected" event has already fired), and the `run_prepared` continuation
  loop starts the new agent's pipeline on it. Side-effecting builtin tool
  executions are shielded from Pipecat's cancel-on-interruption so a caller
  speaking over the tool call cannot kill the handover mid-flight.

Caveats:

* Full handover requires the target's model to run on the same worker
  (`livekit:` ↔ `livekit:`, `pipecat:` ↔ `pipecat:`).
* On Pipecat, full handover works on the websocket SIP gateways
  (FreeSWITCH / sipbridge / voiceblender) and browser WebRTC sessions;
  Daily legs, consultation legs, and calls with an ENGAGED media relay
  refuse it with `FAILED`.
* Concurrency is re-checked for the child call: a busy target agent aborts
  the handover with `FAILED` and the current agent keeps the call.
* Recording does not continue across a full handover on LiveKit (covers up to
  the handover); Pipecat records each call segment separately.
* On LiveKit, a same-model in-place swap on Ultravox realtime is only used
  when the tool surface is unchanged; any tool difference forces the full
  restart.

## 2. Agent sets (`/agent-sets` API)

Create a whole team in one call:

```http
POST /api/agent-sets
```

```json
{
  "name": "Front office",
  "description": "Triage, sales and a research subagent",
  "agents": [
    {
      "label": "triage",
      "name": "Triage",
      "modelName": "livekit:ultravox/ultravox-70b",
      "prompt": "You answer the phone, work out what the caller needs...",
      "functions": [
        {
          "name": "transfer_to_sales",
          "implementation": "builtin",
          "platform": "transfer_agent",
          "description": "Hand over to sales",
          "input_schema": {
            "type": "object",
            "properties": {
              "agent": { "type": "string", "source": "static", "from": "label:sales" },
              "includeHistory": { "type": "boolean", "source": "static", "from": true }
            }
          }
        },
        {
          "name": "ask_researcher",
          "implementation": "builtin",
          "platform": "subagent",
          "description": "Ask the research agent to look something up",
          "input_schema": {
            "type": "object",
            "properties": {
              "agent": { "type": "string", "source": "static", "from": "label:researcher" },
              "question": { "type": "string", "required": true, "description": "What to research" }
            }
          }
        }
      ]
    },
    { "label": "sales", "modelName": "livekit:ultravox/ultravox-70b", "prompt": "You are the sales agent..." },
    {
      "label": "researcher",
      "type": "text",
      "modelName": "text:openai/gpt-4o",
      "prompt": "You answer product questions concisely...",
      "functions": [
        {
          "name": "deliver_result",
          "implementation": "builtin",
          "platform": "result",
          "description": "Deliver your answer",
          "input_schema": {
            "type": "object",
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

Semantics:

* Every member needs a `label` (unique within the set,
  `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`). Members are otherwise ordinary agents —
  they appear in `GET /agents`, can be activated with listeners, etc.
* `label:<label>` references in `transfer_agent`/`subagent` `agent` parameters
  are **fixed up to the real agent UUIDs** when the set is created or updated.
  The original label is kept alongside the resolved id as `fromLabel`, so a
  document read back with `GET /agent-sets/{id}` can be edited and `PUT` back
  without re-writing ids — labelled references are always re-resolved against
  the current membership.
* The whole operation is transactional: a bad reference (unknown label,
  cross-tenant UUID, wrong target type) fails the entire request and leaves
  nothing behind.
* `PUT /agent-sets/{id}` reconciles by label: existing labels are updated in
  place (keeping their agent ids — live listeners stay attached), new labels
  are created, absent labels are deleted.
* A member's stored functions that reference a **write-only key entry** (their
  `key` property — platform-wired tools such as calendar booking, injected onto
  the rows by an attach panel rather than authored in the document) are
  **preserved on update even when the incoming member's `functions` omits
  them**. Key values never round-trip through `GET`, so no document-driven
  editor can faithfully re-author a keyed function; a stale working copy must
  therefore never strip one by omission. An incoming function of the same name
  still replaces the stored one, and listing a name in the member's
  `removeFunctions` array deletes it explicitly (`removeFunctions` also works
  without resending `functions` at all — a remove-only patch).
* `DELETE /agent-sets/{id}` removes the set and all member agents.

Endpoints: `POST /agent-sets`, `GET /agent-sets`, `GET /agent-sets/{id}`,
`PUT /agent-sets/{id}`, `DELETE /agent-sets/{id}`.

Cross-reference rules: `transfer_agent` must target an `interactive-audio`
agent; `subagent` must target a `text` agent; static UUID targets are checked
for existence and tenancy at create/update time (this applies to plain
`POST /agents` too).

## 3. Text subagents (`type: "text"`, `subagent` and `result` builtins)

A new agent type for headless work:

* `Agent.type` is `interactive-audio` (default) or `text`. The type is
  defaulted from the model name, so any agent with a `text:`-prefixed model is
  a text agent.
* Text agents use `text:<provider>/<model>` model names
  (e.g. `text:openai/gpt-4o`, `text:anthropic/claude-3-5-sonnet-20240620`,
  `text:gemini/gemini-1.5-pro`, `text:groq/...`) — the same provider
  implementations as the Jambonz pipeline, with no audio leg.
* They cannot `listen`; they are invoked:
  * by a voice agent through a builtin `subagent` platform function — the
    function's `generated` parameters become the subagent's task input, and
    the function result delivered back to the calling LLM is whatever the
    subagent passed to its `result` function; or
  * directly via `POST /agents/{agentId}/invoke` with
    `{ "input": {...}, "metadata": {...} }` — handy for testing a text agent in
    isolation. The response is `{ result, complete, transcript }`.
* Inside the invocation, the text agent runs a normal tool loop: its own
  `rest`/`stub` functions are dispatched through the shared function handler,
  and it may itself call further `subagent` functions (nesting is depth-limited
  to 3). The loop ends when the agent calls a builtin `result` platform
  function; the `input_schema` of that function is how you specify the shape of
  output you require. An agent with no `result` function returns its first
  plain-text completion as `{ "text": ... }`.
* Server-side execution is bounded: 10 LLM round trips per invocation and a
  wall-clock timeout (`SUBAGENT_TIMEOUT` ms, default 60000).

The voice-side `subagent` dispatch is available in the LiveKit and Pipecat
workers (both via the internal `/agent-db/subagent` API) and anywhere the
shared function handler runs in-process.

## Support matrix

| Capability | livekit | jambonz | pipecat | ultravox | text |
|---|---|---|---|---|---|
| `transfer_agent` (in place, same model) | ✅ ¹ | ❌ | ✅ (not Ultravox realtime) | ❌ | n/a |
| `transfer_agent` (full restart + child call) | ✅ | ❌ | ✅ (ws SIP gateways + browser WebRTC) | ❌ | n/a |
| `subagent` caller | ✅ | ❌ | ✅ | ❌ | ✅ (nested) |
| `result` / invokable | n/a | n/a | n/a | n/a | ✅ |

¹ LiveKit Ultravox realtime swaps in place only when the tool surface is
unchanged; otherwise it falls through to the full restart.

Validation enforces this: saving an agent with a `transfer_agent`/`subagent`
function on a handler that doesn't support it is rejected with a clear error,
as is a `result` function on a non-text agent.

## Internal APIs (shared-token, workers only)

* `GET /agent-db/agent?agentId=...&expectedOrganisationId=...` — full agent
  definition fetch for in-call handover (404 on organisation mismatch).
* `POST /agent-db/subagent` — `{ agentId, input, metadata, organisationId,
  callId }` → `{ result, complete }`.

## Schema/database notes

* New `agent_sets` table; `agents` gains `type`, `label`, and `agent_set_id`
  (unique index on `(agent_set_id, label)`); schema version 37.
* Function definitions: new builtin platforms `transfer_agent`, `subagent`,
  `result` (OpenAPI `Functions` schema updated); `fromLabel` annotation on
  fixed-up `agent` parameters.
