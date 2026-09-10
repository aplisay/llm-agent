# OpenAI GPT-Live

GPT-Live (`gpt-live-1`) is OpenAI's full-duplex voice model. It listens and
speaks at the same time, decides its own turns and barge-in, and hands
reasoning and tool use to a separate backend model while it keeps talking.
The platform offers it as the realtime row `pipecat:openai/gpt-live-1`.

This page covers how to configure an agent on it, how the backend is
expressed, and how that relates to the text subagents the platform already
has. A worked guide that builds a complete set step by step, keeps specialist
subagents and switches the backend between providers is
[gpt-live-agent-sets.md](gpt-live-agent-sets.md). The LiveKit row
(`livekit:openai/gpt-live-1`) follows when the upstream LiveKit plugin ships.

## Two layers, two agents

A GPT-Live session has two models:

| Layer | Model | Takes | Does |
|---|---|---|---|
| Voice | `gpt-live-1` | instructions, a voice | listens, speaks, decides when to delegate |
| Backend | a text model | instructions, tools | reasons, calls tools, returns an answer for the voice model to speak |

The voice model never sees the tools. When it decides the caller needs a
lookup or an action, it creates a delegation. The backend works while the
voice model keeps the conversation going, and the voice model relays the
answer when it arrives.

The platform maps the two layers onto two agents:

- The **voice agent** is the agent on `pipecat:openai/gpt-live-1`. Its
  `prompt` is the voice persona: who it is, how it speaks, when to delegate.
- The **backend** is a `text` agent, named by one builtin function with
  `platform: "delegate"` on the voice agent. Its `prompt` is the backend
  instructions, its `modelName` the backend model, its `functions`,
  `mcpServers` and `keys` the backend tools, `options.effort` the reasoning
  effort and `options.maxTokens` the output cap.

Inside an agent set the two sit side by side:

```json
{
  "name": "Acme Dental reception",
  "agents": [
    {
      "label": "voice",
      "modelName": "pipecat:openai/gpt-live-1",
      "prompt": "You are Sam, the receptionist for Acme Dental. Keep replies short and warm.",
      "options": {
        "tts": { "voice": "marin" },
        "greeting": { "text": "Acme Dental, Sam speaking." }
      },
      "functions": [
        {
          "name": "brain",
          "implementation": "builtin",
          "platform": "delegate",
          "description": "Handles lookups, bookings and anything needing tools",
          "input_schema": { "properties": { "agent": { "source": "static", "from": "label:brain" } } }
        },
        {
          "name": "hangup",
          "implementation": "builtin",
          "platform": "hangup",
          "input_schema": { "properties": {} }
        }
      ]
    },
    {
      "label": "brain",
      "type": "text",
      "modelName": "text:openai/gpt-5.6-terra",
      "prompt": "You book and amend appointments for Acme Dental. Check availability before offering a slot.",
      "options": { "effort": "low" },
      "functions": [
        { "name": "get_slots", "implementation": "rest", "url": "https://example.com/slots" }
      ],
      "mcpServers": [ { "name": "crm", "url": "https://example.com/mcp" } ]
    }
  ]
}
```

Outside a set the `agent` parameter is the text agent's UUID, or a
`metadata` reference resolved per call.

## The `delegate` function

`delegate` is declared exactly like `subagent`:

- One parameter, `agent`, sourced `static` (a UUID, or `label:<label>` inside
  an agent-set document) or `metadata`. Never `generated`.
- The target must be a `text` agent in the same organisation.
- No other parameters. The voice model never calls this function; it only
  names the backend.
- At most one per agent, and only on models flagged `hasDelegation` in
  `GET /models`.

Rules the API enforces when the agent is saved:

- a `delegate` on a model without `hasDelegation` is rejected;
- a second `delegate`, or any parameter other than `agent`, is rejected;
- inside an agent set, a voice member and its in-set delegate that both
  declare a function of the same name are rejected (see tools below).

## No `delegate` declared

A GPT-Live agent with no `delegate` function still works. The platform
synthesises the backend from the voice agent itself: the same prompt, the
agent's own functions, MCP servers and builtins, on `openai/gpt-5.6-luna`.
An existing agent moved onto `pipecat:openai/gpt-live-1` runs unchanged.
Declare a `delegate` when you want a different model, a different prompt, or
tools and keys that belong to the backend rather than the voice agent.

## How this relates to text subagents

The platform already lets a voice agent call a `text` agent like a tool
through the `subagent` builtin. The two are different things:

| | `subagent` | `delegate` |
|---|---|---|
| What it is | a tool the model chooses to call | the backend the voice model hands the conversation to |
| Who calls it | the voice model (or, on GPT-Live, the backend) with generated inputs | nobody; the voice model delegates on its own |
| Inputs | the generated parameters of the function | the conversation so far |
| Output | the text agent's `result` arguments, returned as a tool result | the backend's answer, which the voice model speaks |
| Per agent | any number | at most one |
| Where it runs | the platform, through the internal subagent endpoint | OpenAI (for an OpenAI text model) or the platform (client delegation) |

They compose. The backend can carry `subagent` functions of its own, and the
voice agent's `subagent` functions are part of the merged backend tool set,
so a GPT-Live agent can still consult a knowledge subagent the way any voice
agent does today. The set builder's guidance is the same: route knowledge
through a text subagent, and use `delegate` for the model that owns the
tools.

## Delegation modes

The delegate's `modelName` picks the mode. It is fixed for the session.

**OpenAI-hosted (responses) delegation**, for `text:openai/*` delegates. OpenAI
runs the backend model. The backend's function calls come back to the
Pipecat worker, which executes them with the owning agent's keys and returns
the results, so REST functions, MCP tools and the call-control builtins all
work. This is the mode of the synthetic backend too.

**Client delegation**, for any other text model (Anthropic, Gemini, Kimi,
OpenRouter, DeepSeek). Each delegation becomes a synthetic subagent call
through the same internal endpoint a `subagent` function uses, with the
transcript since the previous delegation as the task input. The answer is
appended to the session as commentary and the voice model speaks it in its
own words. A failure is spoken as a short apology. The backend's own
functions and MCP servers work; the voice agent's call-control builtins
(`hangup`, `transfer`, `transfer_agent`, `send_dtmf`) do not reach a client
delegate, because nothing on the OpenAI side can call them. Use an OpenAI
delegate when the backend must control the call.

## Tools

The backend's tool set is the union of:

- the delegate's `functions` and `mcpServers`, executed with the delegate's
  `keys`;
- the voice agent's `functions`, `mcpServers` and builtins (`hangup`,
  `transfer`, `transfer_status`, `transfer_agent`, `subagent`, `send_dtmf`,
  `metadata`), executed with the voice agent's `keys`.

Each function runs in the worker with its own agent's keys, and results
return to the backend on the call that asked for them. A name declared on
both sides resolves in the delegate's favour and is logged at call start;
inside an agent set the clash is rejected when the set is saved.

Every tool behaves as not cancelled by interruption: the voice model handles
being talked over itself, and a delegation keeps running while it does.

## Voices

`GET /models/pipecat:openai/gpt-live-1/voices/any` lists the GPT-Live voices
under the `OpenAI` vendor: alloy, ash, ballad, beacon, bossa, cedar, cinder,
coral, delta, echo, gleam, marin, meridian, quartz, ripple, sage, shimmer,
stone, tempo, verse, vesper and willow. The default is `marin`. The list
differs from OpenAI Realtime's, and a Realtime-only name is rejected.

`options.tts.vendor` must be unset or `openai`. There is no text-output mode
(`hasExternalTts` is false), so an external TTS vendor is rejected.

## Options

| Option | On GPT-Live |
|---|---|
| `greeting.text`, `greeting.instructions` | An opening instruction appended after the session starts, audible about a second later. The model reads `text` closely but not guaranteed verbatim. The caller is inaudible to the model until the opening line completes. |
| no greeting | The platform asks the model to greet the caller and ask how it can help, so the agent still speaks first. |
| `inactivity` | Idle detection unchanged. The prompt is delivered as spoken context, so it is paraphrased. Repeat count and `hangup` unchanged. |
| `maxDuration` | Unchanged. |
| `dtmfTimeout`, `dtmfTerminator` | Digits go to the backend as typed input and to the voice model as context. In client delegation they are prepended to the next delegation's input. |
| `transfer_agent` | Always a full restart of the agent stack with the transcript carried into the new agent. |
| `transfer`, bridged transfers, `recording`, `stt.aux`, `tts.output` | Unchanged. |
| `tts.language`, `stt.language` | Appended to the voice instructions as the language to speak. |
| `temperature` | Ignored. The Live API takes no temperature for either layer. |
| `effort`, `maxTokens` | Read from the delegate (backend reasoning effort and output cap). |
| `vendorSpecific.openai.live` | Merged into the Live API `session.start` configuration after the platform mapping. An explicit value here wins. |
| `voiceMode` | Must be `realtime` or unset. |

`vendorSpecific.openai.live` example:

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

## Usage and billing

GPT-Live is billed per minute of session, like Ultravox. The minutes land on
the call's `voice` row and are priced by the model's minute line
(`model:pipecat:openai/gpt-live-1` in the rate-component catalogue). The
backend's tokens are metered as `llm` rows against the delegate's model, so
the existing token line for that text model prices them. In client
delegation the tokens are attributed to the call by the subagent endpoint,
as for a `subagent` call today.

## Limits and caveats

- Instructions, voice and delegation mode cannot change once the session has
  started. A handover to another agent restarts the stack.
- Greeting and inactivity wording are requests, not guarantees, as on OpenAI
  Realtime.
- A handover carries at most the most recent 128 messages or 8,192 tokens of
  transcript into the new session.
- Some queued audio may play after the model stops on a barge-in.
- Concurrent session limits apply per OpenAI project tier.
- A session the provider closes (expiry, a content policy close, a lost
  connection) ends the call cleanly with that reason.
- The Pipecat worker's `OPENAI_API_KEY` must belong to a project with
  GPT-Live access.
