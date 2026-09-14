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

### When a responses delegation is refused

The responses backend holds its own input history, capped at **128 items and
32,768 UTF-8 bytes for the whole session**, and every tool result the worker
returns is charged against it. One oversized result exhausts it: the item is
refused with `response_input_buffer_full`, and because the backend counts that
function call as unanswered it then refuses to continue the response at all
(`function_call_outputs_required`).

Left alone this strands the call rather than failing it. The live session stays
healthy, so the line stays up and the agent simply stops answering. That is
what happened on 2026-09-14: four whole documents (92 KB) were fetched in one
turn, and the caller sat in silence for 82 seconds before hanging up.

The worker now recovers in two steps:

1. **Answer the refused call with a placeholder.** A few dozen bytes fit where
   the result did not, so the backend is no longer owed an output and the
   response resumes. The placeholder says the result was too large and to ask
   for a smaller part, so the model narrows its request instead of treating the
   tool as broken, and it answers from what it does have.
2. **Speak if nothing comes back.** If the delegation shows no sign of life
   within a few seconds of a fault, the voice model is told to apologise and
   offer what it can. This runs whether or not step 1 worked, because the
   failure being prevented is silence, not error.

The input budget is per session, so once it is exhausted later delegations fail
the same way. The caller is told once, not once per attempt. Both steps are
logged under `event="delegation_recovery"` in the call's debug log.

Tool results are also bounded on the way in. MCP servers and REST functions both
call out to third parties that can return whatever they like, so the worker caps
every result and tells the model it did: 8,000 bytes normally, and 2,500 on
GPT-Live, where the budget has to cover a whole call's tool use rather than one
turn (`MAX_RESULT_BYTES` and `MAX_RESULT_BYTES_DELEGATED` in `tool_result.py`).

On GPT-Live the tighter cap applies to **every** tool the agent has, not just
the delegate's own. In responses mode the merged tool set is one surface: a
result from the voice agent's REST function goes back to the backend as
delegation input exactly as the delegate's does, and is charged against the same
budget.

The cap bounds what the model is shown, not what is kept. A REST function's full
result still reaches `metadata.toolsCalls` for tool chaining, the same split
`redact` already uses. A truncated result is logged as a warning with the byte
counts, because the debug log's own copy of a result is capped too.

Capping makes the failure rare; the recovery above makes it survivable. Neither
removes the session budget, so prefer tools that return the part you asked for
over ones that return whole documents.

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

Every voice sits under `any`, so the locale says nothing about accent. Each
row carries a `gender`, and a `description` that names the accent. The
`list_voices` builtin's `search` matches both. A search for `british`, `brit`
or `uk` finds vesper (British English) and the two Irish English voices,
stone and willow, whose descriptions say "more British (UK)".

The two Southern US voices, cinder and delta, say "US (American, USA)", so a
search for `us`, `usa` or `american` finds them. `american` also finds the two
North American voices, gleam and meridian.

| Voice | Gender | Accent |
|---|---|---|
| alloy | female | none given |
| ash | male | none given |
| ballad | male | none given |
| beacon | male | Filipino English |
| bossa | female | Brazilian Portuguese |
| cedar | male | none given |
| cinder | male | Southern US English |
| coral | female | none given |
| delta | female | Southern US English |
| echo | male | none given |
| gleam | female | North American English |
| marin (default) | female | none given |
| meridian | male | North American English |
| quartz | female | Australian English |
| ripple | male | Australian English |
| sage | female | none given |
| shimmer | female | none given |
| stone | male | Irish English |
| tempo | male | Brazilian Portuguese |
| verse | male | none given |
| vesper | male | British English |
| willow | female | Irish English |

The accents of the twelve voices added with GPT-Live follow OpenAI's
descriptions. OpenAI gives no accent for the other ten, and their gender is
Aplisay's label.

By default `options.tts.vendor` must be unset or `openai`. GPT-Live has no text-only
response modality: the row reports `hasExternalTts: false` and any other vendor
is rejected unless the transcript-synthesis prototype below is enabled. This is
unlike `pipecat:openai/gpt-realtime`, which shares the `openai` provider
segment but is a different API: the Realtime API takes
`output_modalities: ["text"]`, and the Live API's `session.start` has no
modality field at all (its only output events are audio deltas and the
transcript of that audio). See [realtime-external-tts.md](realtime-external-tts.md)
for the rows that do support it.

### Experimental transcript TTS

On the Pipecat worker, opt in with `options.tts.experimentalTranscript: true`
and select an external TTS vendor. For example, this agent configuration uses
Deepgram to speak GPT-Live's output transcript:

```json
{
  "modelName": "pipecat:openai/gpt-live-1",
  "prompt": "You are a helpful receptionist. Keep replies short.",
  "options": {
    "tts": {
      "experimentalTranscript": true,
      "vendor": "deepgram",
      "voice": "aura-athena-en",
      "language": "en-GB"
    }
  }
}
```

The worker needs its usual OpenAI credentials and the selected TTS provider's
credentials (`DEEPGRAM_API_KEY` for this example). Existing delegate configuration
continues to work. The option is off by default; remove it and the external vendor
to return to native audio. The model's voice picker and `hasExternalTts` remain
unchanged because it has no supported text-only modality; choose external voices
from the corresponding pipeline TTS catalogue.

The worker discards native audio and feeds `session.output_transcript.delta`
fragments, preserving their spacing, to the external TTS stage. Native TTS text
and start/stop frames are suppressed so synthesized speech is not duplicated in
the audit transcript.

For ElevenLabs, the experimental path uses phrase streaming with `auto_mode=true`
and the existing Flash v2.5 model. The first chunk is released at punctuation,
four complete words, or a 250 ms deadline when complete words are available.
Following chunks use punctuation, twelve words, or a 600 ms deadline. Split
words are retained until their boundary arrives; turn completion flushes the
remainder. These are buffering budgets, not promised end-to-end latency. The
same ElevenLabs context is reused within a response. Normal pipeline TTS and
Realtime text-output sessions retain their existing sentence aggregation.

Local VAD interrupts immediately when caller speech begins during external
playback. Before playback, it allows 600 ms of speech after VAD confirmation
(the VAD itself also has a speech-onset threshold), so a brief acknowledgment
does not automatically clear a queued reply. Sustained speech still cancels
queued synthesis and playback. This is a duration heuristic, not a semantic
acknowledgment classifier; speech can begin during that grace period. The
microphone remains connected to GPT-Live, which can independently change its
answer. Late pre-interruption captions are discarded, and a timestamped new
answer can resume even without an intervening transcript-gap boundary.
Delegated tool calls continue through local interruptions. The existing greeting
guard feeds silence to OpenAI until external playback finishes, with its existing
timeout as a fallback if synthesis fails.

ElevenLabs trials log `transcript_tts_latency` events with a per-response `trace`,
`stage`, monotonic timestamp, and milliseconds since `first_transcript`:
`first_tts_submission`, `first_audio`, and `playback_start`. Subtract consecutive
stage times to separate caption buffering, synthesis, and local output buffering.
Playback is measured after the transport successfully writes its first TTS audio
chunk; it excludes downstream network/jitter buffering and is not proof the
remote caller heard it. Interrupted responses also log `interrupted`; responses
that fail or are cancelled may lack later stages. These logs contain no transcript
text. Stage correlation uses TTS context IDs so queued responses remain separate.

This is a prototype: OpenAI still generates audio and charges for the Live session;
external TTS usage is additional. Transcript delivery has no guaranteed lead over
native audio, so synthesis adds latency and its playback can drift from the Live
model's speech timeline. Transcript turn boundaries are inferred from gaps, not
authoritative API events. The model may believe words were heard when they were
discarded or interrupted. No text modality is sent to OpenAI.

For a live trial, check the greeting, multi-sentence replies, interruptions during
speech and pauses, and a delegated tool call interrupted while running. Compare
the recording and bot transcript, verify only one voice is audible, and measure
time to first speech and how much audio continues after barge-in. Offline tests
exercise frame routing and interruption state; they cannot establish live latency
or conversational quality.

## Options

| Option | On GPT-Live |
|---|---|
| `greeting.text`, `greeting.instructions` | An opening instruction appended after the session starts, audible about a second later. The model reads `text` closely but not guaranteed verbatim. The caller is inaudible to the model until the opening line completes. |
| no greeting | The platform asks the model to greet the caller and ask how it can help, so the agent still speaks first. |
| `inactivity` | Idle detection unchanged. The prompt is delivered as spoken context, so it is paraphrased. Repeat count and `hangup` unchanged. |
| `maxDuration` | Unchanged. |
| `dtmfTimeout`, `dtmfTerminator` | Digits go to the backend as typed input and to the voice model as context. In client delegation they are prepended to the next delegation's input. |
| `transfer_agent` | Always a full restart of the agent stack with the transcript carried into the new agent. The incoming agent's greeting is not used: it opens with an instruction to introduce itself and continue the call. The caller is not made inaudible for that opening. |
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
