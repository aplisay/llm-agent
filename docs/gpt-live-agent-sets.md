# GPT-Live with Aplisay: native delegation, familiar agent sets

**If you already use Aplisay agent sets and text subagents, you already know
how to build with GPT-Live.** Put a GPT-Live voice agent alongside a text
agent in your set, connect them with `label:backend`, and create the team
with the same `POST /agent-sets` request you use today.

Aplisay pioneered the pattern of voice agents working with specialist text
subagents. GPT-Live brings native delegation into that same model: the voice
agent handles the conversation while a text agent handles reasoning and
tools. Your existing specialists remain ordinary set members, with their own
prompts, models and tools, ready to join the conversation behind the scenes.

**Aplisay combines GPT-Live's native OpenAI delegation with access to its full
text-model catalogue.** Use an OpenAI backend for native hosted delegation,
choose another supported provider for the backend, or combine an OpenAI
backend with specialists from other providers. The set document is your
integration surface in every case. Aplisay manages the delegation transport
and execution; you define the agents and their relationships.

This guide walks through all three patterns using a fictional cycle shop.
The examples target a deployment with the GPT-Live API and Pipecat worker
support enabled. Model availability and permissions are specific to your
deployment; check `GET /models` before creating the set.

## The small addition to a set you already understand

There are two roles:

| Set member | Responsibility | Configuration |
|---|---|---|
| Voice agent | Listen, speak, maintain the persona and decide when to delegate | `modelName: "pipecat:openai/gpt-live-1"`, voice prompt and audio options |
| Backend text agent | Reason, look things up, use tools and produce an answer to speak | A `text:` model, backend prompt, functions and model options |

The connection is a builtin function on the voice agent:

```json
{
  "name": "use_backend",
  "implementation": "builtin",
  "platform": "delegate",
  "description": "The backend for shop information and customer requests.",
  "input_schema": {
    "properties": {
      "agent": {
        "type": "string",
        "source": "static",
        "from": "label:backend"
      }
    }
  }
}
```

The `agent` reference uses exactly the label mechanism you already use for
`subagent` and `transfer_agent`. Aplisay resolves it to the member's UUID
when it saves the set. The function name is yours to choose;
`platform: "delegate"` selects the behaviour.

The important difference is what this declaration means. `delegate` selects
the backend for the session. It is not a tool the voice model calls with a
generated `question` argument. GPT-Live decides when to delegate and supplies
the conversation context. Declare only the `agent` parameter.

| Relationship | When to use it | What happens |
|---|---|---|
| `delegate` | Select GPT-Live's reasoning and tool backend | GPT-Live delegates while continuing to handle the voice conversation; at most one backend per voice agent |
| `subagent` | Give an agent a specialist to consult | The calling model supplies task arguments; the specialist returns a tool result; several specialists can coexist |
| `transfer_agent` | Hand the live conversation to a different voice agent | The target takes over the call, subject to the worker's transfer support |

You can use `delegate` and `subagent` together. Keep existing specialists as
specialists, and give the backend `subagent` functions to consult them.

## Example 1: create a complete GPT-Live set

This first example needs no external tool service. A stub provides fixed
shop hours so you can verify delegation before connecting your business API.

The commands use `curl` and `jq`. Set your API base URL and an Aplisay bearer
token with permission to create, invoke and deploy agents:

```bash
export APLISAY_API_BASE="https://llm-agent.aplisay.com/api"
export APLISAY_TOKEN="YOUR_APLISAY_TOKEN"

curl --fail-with-body --silent --show-error \
  "$APLISAY_API_BASE/models" \
  -H "Authorization: Bearer $APLISAY_TOKEN" > models.json

jq '.["pipecat:openai/gpt-live-1"]' models.json
jq -r 'keys[] | select(startswith("text:"))' models.json
```

The GPT-Live row must be present and report `hasDelegation: true`. It also
reports `hasExternalTts: false`: GPT-Live uses its own voices. This guide uses
`marin`, the default. Discover the model's voice list with:

```bash
curl --fail-with-body --silent --show-error \
  "$APLISAY_API_BASE/models/pipecat:openai/gpt-live-1/voices/any" \
  -H "Authorization: Bearer $APLISAY_TOKEN"
```

Save this complete document as `cycle-shop.json`. Confirm that
`text:openai/gpt-5.6-terra` is available in your model list, or select an
available OpenAI text model suitable for native delegation.

```json
{
  "name": "Cycle shop with GPT-Live",
  "description": "A voice receptionist with a separate reasoning backend.",
  "agents": [
    {
      "label": "reception",
      "name": "Cycle shop reception",
      "modelName": "pipecat:openai/gpt-live-1",
      "prompt": "You are Sam at the fictional Riverside Cycles demo shop. Be warm and brief. Delegate shop facts and requests needing tools to the backend. Tell the caller when you are checking. Never invent opening hours or claim a booking has been made.",
      "options": {
        "tts": { "voice": "marin" },
        "greeting": { "text": "Riverside Cycles, Sam speaking. How can I help?" }
      },
      "functions": [
        {
          "name": "use_backend",
          "implementation": "builtin",
          "platform": "delegate",
          "description": "Handle shop facts and requests needing tools.",
          "input_schema": {
            "properties": {
              "agent": { "type": "string", "source": "static", "from": "label:backend" }
            }
          }
        },
        {
          "name": "end_call",
          "implementation": "builtin",
          "platform": "hangup",
          "description": "End the call after the caller confirms they need nothing else and you have said goodbye.",
          "input_schema": { "properties": {} }
        }
      ]
    },
    {
      "label": "backend",
      "name": "Cycle shop backend",
      "type": "text",
      "modelName": "text:openai/gpt-5.6-terra",
      "prompt": "You support the Riverside Cycles voice receptionist. Use get_shop_hours for opening-hours questions. Do not guess facts or claim you can book repairs. Return a short plain-text answer for Sam to speak. If the caller is finished, use end_call only after the goodbye.",
      "options": { "effort": "low", "maxTokens": 1024 },
      "functions": [
        {
          "name": "get_shop_hours",
          "implementation": "stub",
          "description": "Get the demo shop's opening hours.",
          "input_schema": { "properties": {} },
          "result": "Riverside Cycles demo hours: Monday to Friday 09:00-18:00; Saturday 10:00-16:00; Sunday closed."
        }
      ]
    }
  ]
}
```

Create both agents and their relationship in one request:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$APLISAY_API_BASE/agent-sets" \
  -H "Authorization: Bearer $APLISAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @cycle-shop.json > cycle-shop-created.json

SET_ID=$(jq -er '.id' cycle-shop-created.json)
VOICE_ID=$(jq -er '.agents[] | select(.label == "reception") | .id' cycle-shop-created.json)
BACKEND_ID=$(jq -er '.agents[] | select(.label == "backend") | .id' cycle-shop-created.json)

jq '.agents[] | select(.label == "reception")
  | .functions[] | select(.platform == "delegate")
  | .input_schema.properties.agent' cycle-shop-created.json
```

The last command shows the resolved backend UUID in `from` and the original
label `backend` in `fromLabel`. The set response includes the set ID and its
members; you do not need a separate agent-creation or relationship API.

### Check the backend, then make a call

You can test the backend independently using the existing text-agent API:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$APLISAY_API_BASE/agents/$BACKEND_ID/invoke" \
  -H "Authorization: Bearer $APLISAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"input":{"task":"What time does Riverside Cycles close on Saturday?"}}'
```

Expect an answer stating 16:00, grounded in `get_shop_hours`. The response
contains `result`, `complete` and `transcript`; inspect the transcript for the
tool call. This backend has no `result` builtin, so its ordinary text reply
is returned as `result.text`. Direct invocation checks its prompt and own
tools; the merged voice tools, including `end_call`, are available during a
native GPT-Live call and are not part of this isolated test.

Activate the **voice member**, using a phone number already allocated to
your organisation and available for this demo:

```bash
export APLISAY_DEMO_NUMBER="YOUR_ALLOCATED_E164_NUMBER"

jq -n --arg number "$APLISAY_DEMO_NUMBER" '{number: $number}' > listener.json
curl --fail-with-body --silent --show-error \
  -X POST "$APLISAY_API_BASE/agents/$VOICE_ID/listen" \
  -H "Authorization: Bearer $APLISAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @listener.json
```

Call that number and ask, “What time do you close on Saturday?” Sam should
acknowledge the request, delegate it, then relay the 16:00 answer. GPT-Live
continues managing the voice conversation while the backend works. Exact
phrasing, including the configured greeting, may be paraphrased.

For browser calling, use your existing Pipecat WebRTC listener and join flow
with `VOICE_ID`. Text members do not need listeners.

### Connect a real tool

Replace the `get_shop_hours` stub with a REST function when your service is
ready. For example, the following function makes a GET request; replace the
illustrative URL with your own endpoint returning opening-hours data:

```json
{
  "name": "get_shop_hours",
  "implementation": "rest",
  "description": "Get the shop's current opening hours.",
  "method": "get",
  "url": "https://api.example.com/shop/hours",
  "input_schema": { "properties": {} }
}
```

Attach credentials through the owning agent's `keys` and the function's
`key` reference if required. The backend owns this tool, so its credentials
belong on the backend. The same ownership rule applies to
[MCP servers](mcp-servers.md).

## Example 2: keep your specialist text subagents

Native delegation and Aplisay subagents compose naturally. Let the OpenAI
backend handle the conversation's reasoning and call control, and let an
Anthropic specialist answer product-policy questions. You can reuse an
existing specialist's prompt, tools and `result` schema in this role.

Save this complete additional member as `knowledge-agent.json`. Its policy
is fictional demo data; it needs no external service. Check the selected
model against your model list first.

```json
{
  "label": "knowledge",
  "name": "Cycle shop policy specialist",
  "type": "text",
  "modelName": "text:anthropic/claude-sonnet-4-6",
  "prompt": "Answer questions about this fictional demo policy only: new bicycles include one free safety check within six weeks of purchase; repair appointments must be booked by shop staff. Do not invent other terms. Call deliver_answer with a concise answer; if the policy does not cover the question, say that staff must confirm.",
  "functions": [
    {
      "name": "deliver_answer",
      "implementation": "builtin",
      "platform": "result",
      "description": "Return the policy answer to the calling agent.",
      "input_schema": {
        "properties": {
          "answer": { "type": "string", "required": true, "description": "The answer grounded in the demo policy." }
        }
      }
    }
  ]
}
```

Add the specialist and a normal `subagent` function on the backend:

```bash
jq --slurpfile knowledge knowledge-agent.json '
  .agents += $knowledge |
  (.agents[] | select(.label == "backend")) |= (
    .prompt += " For bicycle policy questions, consult ask_policy and relay its answer." |
    .functions += [{
      "name": "ask_policy",
      "implementation": "builtin",
      "platform": "subagent",
      "description": "Ask the policy specialist about bicycle purchases and safety checks.",
      "input_schema": {
        "properties": {
          "agent": {"type": "string", "source": "static", "from": "label:knowledge"},
          "question": {"type": "string", "required": true, "description": "The caller question with relevant context."}
        }
      }
    }]
  )' cycle-shop.json > cycle-shop-specialists.json

curl --fail-with-body --silent --show-error \
  -X PUT "$APLISAY_API_BASE/agent-sets/$SET_ID" \
  -H "Authorization: Bearer $APLISAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @cycle-shop-specialists.json
```

This is an update of the whole demo set. Existing labels keep their agent
IDs and attached listeners; the new `knowledge` label creates a member.
For your own sets, send the complete intended membership: `PUT` reconciles
the document, including removal of omitted members.

Start a new call and ask, “I bought a bicycle three weeks ago. Is a safety
check included?” The intended path is:

1. GPT-Live delegates the request to the OpenAI backend.
2. The backend calls `ask_policy` with the caller's question.
3. The Anthropic text agent calls `deliver_answer`, returning an `answer`
   that confirms the demo's six-week policy.
4. The backend incorporates that tool result; Sam speaks the answer.

That is GPT-Live native delegation and a different provider's specialist
working in the same set. To connect a knowledgebase, configure the
specialist's supported tools or `mcpServers`; the voice-to-backend
relationship stays the same. Keep a specialist's structured `result`
contract on the specialist. The native backend should produce concise text
for the voice agent to speak.

## Example 3: use another provider as the backend

The backend itself can also use Aplisay's wider text-model catalogue:
Anthropic, Gemini, Kimi, DeepSeek and models available through OpenRouter,
subject to your deployment's model access. Choose a `text:` identifier from
`GET /models`.

For example, derive an Anthropic-backed variant from the original two-agent
demo. This variant keeps the hours tool on the backend and removes the
native-mode hangup tool and its prompt instruction:

```bash
jq '
  (.agents[] | select(.label == "backend")) |= (
    .modelName = "text:anthropic/claude-sonnet-4-6" |
    .prompt = "You support a live voice receptionist at the fictional Riverside Cycles demo shop. Read the task containing the caller conversation, use get_shop_hours for opening-hours questions, and return a concise plain-text answer. Do not guess facts or claim to book repairs."
  ) |
  (.agents[] | select(.label == "reception") | .functions) |=
    map(select(.platform != "hangup"))
  ' cycle-shop.json > cycle-shop-anthropic.json

curl --fail-with-body --silent --show-error \
  -X PUT "$APLISAY_API_BASE/agent-sets/$SET_ID" \
  -H "Authorization: Bearer $APLISAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @cycle-shop-anthropic.json
```

If you ran Example 2, this document also removes its `knowledge` member
because it is based on the original two-agent set. Make a new call and ask
the same hours question. The caller still talks to GPT-Live, and the
`label:backend` binding is unchanged; Aplisay selects **client delegation**
from the backend's model name. The caller can end this demo call normally.

### What changes between the two delegation modes?

| Behaviour | Native OpenAI delegation | Aplisay client delegation |
|---|---|---|
| Backend selection | `text:openai/…` | Other supported `text:` providers, including `text:openrouter/…` |
| Execution | OpenAI runs the backend through Responses delegation; Aplisay executes its tool calls | Aplisay invokes the configured text agent through its existing subagent execution path |
| Input | Context supplied by GPT-Live's native delegation | A task containing the transcript since the preceding delegation, plus queued typed input |
| Tools | Voice and backend functions and MCP tools are combined, excluding the `delegate` declaration itself | The text agent's own supported functions and MCP integration |
| Call control | Voice-agent builtins such as `hangup`, `transfer`, `transfer_agent` and `send_dtmf` are available to the backend | Voice-agent call-control tools are not forwarded to the text invocation |
| Answer | Backend output is relayed by GPT-Live | Aplisay appends the text-agent answer as commentary for GPT-Live to speak in its own words |

The full model choice does not imply identical tool support across providers.
For client delegation, put tools and specialist `subagent` functions on the
backend and check that model's `supportsFunctions` and `supportsMcp` flags.
For example, Anthropic text agents support remote MCP through their connector;
other text handlers may store `mcpServers` without executing them.

If your backend must transfer or end the live call, use native OpenAI
delegation and reach other providers through specialist subagents as in
Example 2. Routing an OpenAI model through `text:openrouter/…` selects client
delegation too; the provider path determines the mode.

Client delegations are bounded text-agent invocations, not a persistent
backend chat: each receives the new transcript segment. Store lasting task
state in your application when a workflow needs it. A failed client
delegation prompts a brief spoken apology.

## Bring an existing set across

For a set that already uses text specialists, the integration is small:

1. Change the voice member's model to `pipecat:openai/gpt-live-1` and select a
   GPT-Live voice. Remove external STT/TTS configuration that is specific to
   the previous voice stack; `voiceMode` must be `realtime` or unset.
2. Add or select a text member to own general reasoning and tools. Give it
   backend instructions and retain your existing specialists as text members.
3. Add one `delegate` function to the voice member referencing that backend.
   Keep ordinary `subagent` functions for specialist tasks, including their
   generated task parameters.
4. Save the full set and test a new call. Set updates preserve member IDs
   when labels are unchanged; session configuration is chosen at call start.

Do not simply rename every `subagent` function to `delegate`: a delegate
accepts only `agent`, and there can be only one. For native delegation,
existing voice-side tools and subagent functions are merged into the
backend's tool set, so you can retain their placement. For client
delegation, move the tools the backend needs onto the text member.

You can also try GPT-Live without declaring a delegate. Aplisay builds a
default backend on `text:openai/gpt-5.6-luna` using the voice agent's prompt
and tool configuration. An explicit text member gives you independent
control over the backend model, prompt, tools and credentials.

## Configuration details

### Target rules and alternatives to labels

A `delegate` target must be a text agent in the same organisation. The API
rejects unsupported voice models, multiple delegates, generated targets,
extra parameters and invalid static references. A set also rejects a
function name declared by both its voice member and its in-set delegate;
choose distinct names across the pair.

Outside a set, create the text agent first and use its returned UUID in
the binding's `agent` parameter:

```json
{ "type": "string", "source": "static", "from": "REPLACE_WITH_TEXT_AGENT_UUID" }
```

For a backend selected by your application per call, that parameter can
instead read a metadata path:

```json
{ "type": "string", "source": "metadata", "from": "aplisay.backend" }
```

Supply the text agent UUID at that path in the call metadata before the
session starts. It is resolved once for the session; it does not change
backends in response to later tool results. If a declared backend cannot be
resolved or loaded at call start, the worker logs a warning and uses the
default backend. Ensure your per-call metadata is populated when testing
this form.

### Prompts, tools and options

Keep conversational style and delegation guidance in the voice prompt.
Put business rules, tool-use instructions and the requested answer style
in the backend prompt. For native delegation, tools execute with the keys
of the agent that owns them, even though both agents' tools appear to one
backend. Avoid duplicate names with MCP tools as well; separately created
agents do not have the set's save-time collision protection, and runtime
collisions favour the backend definition.

| Setting | Where to configure it | Behaviour |
|---|---|---|
| Voice | Voice member's `options.tts.voice` | Use the GPT-Live voice list; default `marin` |
| TTS vendor | Voice member's `options.tts.vendor` | Omit or set `openai`; external TTS is unsupported |
| Greeting | Voice member's `options.greeting` | Spoken as an opening instruction; wording may be paraphrased |
| Reasoning effort and answer cap | Backend's `options.effort` and `options.maxTokens` | Use values supported by the selected backend model |
| Temperature | Omit for native GPT-Live delegation | The Live API does not accept it for the voice or native backend layer |
| Provider overrides | Voice member's `options.vendorSpecific.openai.live` | Advanced Live session settings are merged after the platform mapping and override it |

For example, this **voice-member options fragment** requests the priority
service tier for native Responses delegation:

```json
{
  "vendorSpecific": {
    "openai": {
      "live": {
        "delegation": { "responses": { "service_tier": "priority" } }
      }
    }
  }
}
```

### Usage and rollout

GPT-Live voice usage is billed by session minute on the call's `voice` row.
Backend tokens are metered separately against the selected text model;
specialist subagents retain their existing usage accounting. Changing a
backend changes its token costs without changing the GPT-Live voice model.
Use your deployment's rate card for prices.

The examples use the Pipecat GPT-Live model. The API update must be deployed
alongside a worker with GPT-Live support, and that worker's OpenAI project
must have GPT-Live access. A model appearing in `GET /models` confirms the
API surface; a real call verifies worker configuration and provider access.
Do not substitute a `livekit:` prefix unless your deployment advertises
that model. GPT-Live handovers restart the agent stack and carry transcript
context into the new agent; ordinary worker transfer restrictions still
apply.

For the underlying set lifecycle, invocation responses and transfer rules,
see the [multi-agent API guide](multi-agent-api.md). For knowledgebase tools
and credential configuration, see [remote MCP servers](mcp-servers.md).
