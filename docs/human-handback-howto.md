# How-to: consultative transfer to a remote worker, DTMF hand-back, and automated follow-up

This guide builds a complete workflow around **human-to-agent transfers**
([`bridgedTransferToAgent`](./call-transfers.md#human-to-agent-transfers-bridgedtransfertoagent))
and **bridged-segment transcription**
([`bridgedTransferTranscribe`](./call-transfers.md#transcribing-the-bridged-segment-bridgedtransfertranscribe)):

> A caller reaches your front-desk agent. The agent decides the call needs a
> human — a remote field engineer — and performs a **consultative transfer**
> to their mobile. The engineer takes the call, has a brief conversation with
> the caller ("I can come back Tuesday afternoon to replace the valve"), then
> **presses `1` and puts the phone down**. The caller is seamlessly handed to
> a follow-up agent that has **read the transcript of the human conversation**,
> understands what was agreed, and books the return visit into the engineer's
> calendar before saying goodbye.

The moving parts, end to end:

```
Caller ──► Front-desk agent ──consultative──► Engineer's mobile
                                   │  (TransferAgent briefs the engineer,
                                   │   engineer accepts)
Caller ◄────────bridged───────────► Engineer      ← transcribed segment
                                   │  engineer presses 1, hangs up
Caller ──► Follow-up agent  ──book_appointment──► Calendar API
```

## Prerequisites

- A telephone number or registration endpoint routed to your agent, with
  **outbound calling enabled** on its trunk (transfers dial a new leg).
- Agents on a stack that supports these options — see the
  [topology support table](./call-transfers.md#topology-support). Everything
  below is stack-agnostic; only `modelName` changes.
- A calendar/booking API the follow-up agent can call (any REST endpoint; an
  [MCP server](./mcp-servers.md) works too).

## Step 1 — create the agent set

The two agents are members of one [agent set](./multi-agent-api.md), so the
hand-back target is referenced by **label** rather than UUID and the whole
workflow ships as one document. `POST /agent-sets`:

```json
{
  "name": "Field service front office",
  "description": "Front desk + post-visit follow-up booking",
  "agents": [
    {
      "label": "frontdesk",
      "name": "Front desk",
      "modelName": "pipecat:openai/gpt-4o",
      "prompt": "You are the assistant for Acme Heating. Greet the caller and find out what they need. If they need to speak to the on-call engineer, tell them you are connecting them and call the transfer function. While the consultation is in progress, call transfer_status periodically and keep the caller informed. If the engineer declines or cannot be reached, take a message instead.",
      "options": {
        "transferTone": true,
        "bridgedTransferToAgent": {
          "1": "label:followup"
        },
        "bridgedTransferTranscribe": true,
        "transferPrompt": "You are briefing Acme's on-call engineer about an incoming call. Conversation so far: ${parentTranscript}\n\nSummarise the caller's issue in one or two sentences and ask if they can take the call. Tell them: when you are finished with the caller, press 1 and the assistant will take the call back and book any follow-up visit you agreed. If they accept, call accept_transfer; if not, call reject_transfer with a short reason.",
        "outboundCallFilter": "^\\+447700900123$"
      },
      "functions": [
        {
          "name": "transfer",
          "implementation": "builtin",
          "platform": "transfer",
          "description": "Connect the caller to the on-call engineer (consultative)",
          "input_schema": {
            "type": "object",
            "properties": {
              "number":    { "type": "string", "source": "static", "from": "+447700900123" },
              "operation": { "type": "string", "source": "static", "from": "consultative" }
            }
          }
        },
        {
          "name": "transfer_status",
          "implementation": "builtin",
          "platform": "transfer_status",
          "description": "Check the progress of the transfer",
          "input_schema": { "type": "object", "properties": {} }
        }
      ]
    },
    {
      "label": "followup",
      "name": "Follow-up booking",
      "modelName": "pipecat:openai/gpt-4o",
      "prompt": "You are Acme Heating's booking assistant. You have just taken over a call after the caller finished speaking with our engineer — the transcripts of BOTH earlier conversations are in your context above. Read the section headed 'Conversation between the caller and the human transfer target' and work out what was agreed: usually a return visit, a part to be ordered, or nothing. Confirm your understanding with the caller in one sentence (e.g. 'So Sam is coming back on Tuesday afternoon to replace the valve — shall I book that in?'). If a visit was agreed, call book_appointment with the agreed date and time and a one-line summary of the job, then confirm the booking reference to the caller and say goodbye. If nothing needs booking, thank them and say goodbye.",
      "options": {},
      "functions": [
        {
          "name": "book_appointment",
          "implementation": "rest",
          "method": "post",
          "url": "https://api.example.com/calendar/sam-field-eng/appointments",
          "description": "Book a visit in the engineer's calendar. Returns a booking reference.",
          "input_schema": {
            "type": "object",
            "properties": {
              "start":   { "type": "string", "in": "body", "source": "generated", "required": true,
                           "description": "Appointment start in ISO 8601, e.g. 2026-07-07T14:00:00+01:00" },
              "summary": { "type": "string", "in": "body", "source": "generated", "required": true,
                           "description": "One-line description of the job agreed with the caller" },
              "callerNumber": { "type": "string", "in": "body", "source": "metadata",
                                "from": "aplisay.callerId",
                                "description": "The caller's number, for the calendar entry" }
            }
          }
        },
        {
          "name": "hangup",
          "implementation": "builtin",
          "platform": "hangup",
          "description": "End the call once the booking is confirmed",
          "input_schema": { "type": "object", "properties": {} }
        }
      ]
    }
  ]
}
```

Points worth noting:

- **`"1": "label:followup"`** — the hand-back map. On save the platform
  resolves the label to the member's UUID (recorded as `fromLabel` so the
  document round-trips). Multi-digit keys (`"12"`, `"*7"`) and multiple
  entries mapping different keys to different agents are fine.
- **`bridgedTransferTranscribe: true`** — without this, the follow-up agent
  would only see the *pre-transfer* conversation and would have no idea what
  the caller and the engineer agreed. With it, the human↔human segment is
  transcribed (speaker-labelled) and injected into the takeover prompt.
- **The `transferPrompt` is how the engineer learns about the `1` key.** The
  consultative TransferAgent briefs them privately before they accept, so
  "press 1 when you're done" arrives naturally as part of that briefing. For
  blind transfers there is no briefing step — you would need the engineer to
  know the convention already.
- **`outboundCallFilter`** pins transfers to exactly the engineer's number.
  Always set this in production — see the
  [security notes](./call-transfers.md#outbound-call-filter).
- The follow-up agent needs **no transfer options at all** — it is an
  ordinary agent; the platform delivers the context to it.

## Step 2 — what happens on the call

1. **Consultation.** The front-desk agent calls `transfer` with
   `operation: "consultative"`. The engineer's mobile rings; a TransferAgent
   briefs them (using your `transferPrompt`, with the live conversation
   substituted for `${parentTranscript}`) and they accept. Meanwhile the
   caller hears the front-desk agent (and the comfort tone, since
   `transferTone` is on).
2. **Bridge.** On acceptance the caller and engineer are bridged. Because
   `bridgedTransferToAgent`/`bridgedTransferTranscribe` are set, the
   transfer is **forced onto the bridged path** (never SIP REFER — a REFER
   would take the call off-platform where neither DTMF nor audio can be
   observed). The front-desk agent's call record ends; a **bridged-segment
   child call record** (`modelName: "telephony:bridged-call"`) starts, and
   the platform begins transcribing both humans. The two of them talk
   normally; nothing is in their audio path.
3. **Hand-back.** The engineer presses `1` (only *their* keypad is watched —
   the caller pressing digits does nothing) and hangs up or just waits. The
   platform: reserves the follow-up agent's concurrency slot **first** (if
   the agent is busy, nothing happens and the humans stay connected — the
   engineer can retry), drops the engineer's leg, ends the bridged record
   with `Transfer target handed call back to agent …`, and starts the
   follow-up agent on the caller's leg under a new child call record.
4. **Follow-up.** The follow-up agent reads its prompt (below), confirms the
   arrangement with the caller, calls `book_appointment`, reads back the
   reference, and hangs up.

Every stage is a linked call record under the original call
(`parentId` chains), each with its own transcript, so the whole journey is
auditable from the original call's id.

## Step 3 — what the follow-up agent actually sees

The platform composes the takeover system prompt from the follow-up agent's
own `prompt` plus the carried context. For the call above it looks like:

```text
You are Acme Heating's booking assistant. …(your prompt)…

You have just taken over a live call. The caller was previously speaking
with another agent and was then transferred to a human, who has now handed
the call back to you.

# Conversation between the caller and the previous agent
> caller: Hi, my boiler's making a banging noise again.
> agent: I'm sorry to hear that. Let me get our on-call engineer on the line…

# Conversation between the caller and the human transfer target
> transfer target: Hi, Sam here — I hear the boiler's playing up again?
> caller: Yes, same banging as last winter.
> transfer target: OK, that'll be the fill valve. I can come back Tuesday
  afternoon and swap it — say two o'clock?
> caller: Tuesday at two works.
> transfer target: Great, I'll press one and the assistant will book that in.
```

The second section is the transcribed bridged segment; `> caller:` /
`> transfer target:` labels come from per-leg speaker separation, not
diarisation guesswork. If you set `includeHistory: false` on the map entry
(`"1": { "agent": "label:followup", "includeHistory": false }`), **both**
sections are suppressed and the agent starts fresh — for this use case you
want the default (`true`).

An agent can't reliably be told to ignore injected context it has already
seen, so treat `includeHistory` as the privacy switch: if the human
conversation might contain things the follow-up agent must not know, turn
history off (or leave `bridgedTransferTranscribe` unset, which keeps the
pre-transfer history but omits the human segment). Note that `includeHistory`
governs the *prompt* only — the same transcripts are always seeded into the
takeover call's metadata as `aplisay.transfer.{parentTranscript,
bridgeTranscript, consultTranscript, key, targetNumber}`, where **tools** can
reach them out-of-band (next section).

## Step 3½ — add a summariser to the set

Raw transcripts make the follow-up agent read a lot before its first useful
sentence. The platform pattern for a digest is a **summariser member**: a
`text:` agent in the same set, whose prompt controls what the summary focuses
on and what shape it takes — and whose tokens are billed to you like any
other text-agent call, at whatever model quality you choose.

Add the member:

```json
{
  "label": "summariser",
  "name": "Hand-back summariser",
  "modelName": "text:openai/gpt-4o-mini",
  "type": "text",
  "prompt": "You summarise phone conversations for a follow-up booking agent. From the transcripts you are given, extract: (1) what work was agreed, (2) the agreed date/time if any, (3) anything the caller was promised. Three bullet points, no preamble.",
  "functions": [
    { "name": "result", "implementation": "builtin", "platform": "result",
      "description": "Return the summary",
      "input_schema": { "type": "object", "properties": {
        "answer": { "type": "string", "required": true } } } }
  ]
}
```

Then either — or both — of:

**Pre-fired (recommended):** add `summaryAgent` to the hand-back entry:

```json
"bridgedTransferToAgent": {
  "1": { "agent": "label:followup", "summaryAgent": "label:summariser" }
}
```

The platform fires the summariser **at the moment the engineer presses `1`**
— it cooks while the goodbye and the leg re-arrangement happen — and the
follow-up agent collects it with the builtin `transfer_summary` function
(declare it alongside its other functions; optional `timeoutMs`, default
5000 ms):

```json
{ "name": "transfer_summary", "implementation": "builtin",
  "platform": "transfer_summary",
  "description": "Get the prepared summary of the earlier conversations",
  "input_schema": { "type": "object", "properties": {} } }
```

It returns `{"status": "ready", "summary": …}`, or `pending` (just call it
again — a timeout never cancels the cooking summary), `failed` (fall back to
the injected transcripts), or `none` (no summariser configured).

**Agent-invoked:** give the follow-up agent a `summarise_call` function that
feeds the summariser itself, with the transcripts sourced from metadata so
they travel out-of-band — the model never sees them, only the returned
summary:

```json
{ "name": "summarise_call", "implementation": "builtin", "platform": "subagent",
  "description": "Summarise the conversations that led to this call",
  "input_schema": { "type": "object", "properties": {
    "agent":            { "type": "string", "source": "static",   "from": "label:summariser" },
    "parentTranscript": { "type": "string", "source": "metadata", "from": "aplisay.transfer.parentTranscript" },
    "bridgeTranscript": { "type": "string", "source": "metadata", "from": "aplisay.transfer.bridgeTranscript" },
    "focus":            { "type": "string", "description": "What the summary should concentrate on" } } } }
```

Both modes send the summariser the same arguments, so this one definition
serves either. With a digest in hand you can set `includeHistory: false` and
run the follow-up agent on the summary alone — smaller prompt, faster first
token, and the raw human conversation never enters its context.

**Masking the latency conversationally:** whichever mode you use, prompt the
follow-up agent to greet first and fetch second — "Give me one moment while I
catch up on what you agreed with Sam" — so the tool round-trip hides behind
natural speech. With `summaryAgent` pre-firing, the result is usually already
`ready` by the time the greeting finishes.

## Step 4 — the booking call

`book_appointment` is an ordinary REST function: the LLM generates `start`
and `summary` from the transcript + its confirmation with the caller, and
`callerNumber` is sourced from call metadata rather than trusted to the
model. The engineer's calendar is identified statically in the URL
(`sam-field-eng`) because this agent-set instance *is* Sam's front office. If
one follow-up agent serves several workers, pass the worker's id the same way
the hand-back key is chosen — one map entry per worker
(`"1": "label:followup-sam"`, `"2": "label:followup-alex"`), or look it up
from the transcript via your own API.

Prefer tools over prompt-parsing where precision matters: the transcript
tells the agent *what was agreed*; the confirmation with the caller ("shall I
book that in?") is what guards against STT errors before anything is
written to the calendar.

## Testing checklist

1. Create the set, `POST /agents/{frontdeskId}/listen` (or attach a number),
   and call in.
2. Ask for the engineer; check `transfer_status` progresses
   `dialling → talking → none` as the engineer accepts.
3. While bridged, watch the bridged-segment call record appear
   (`GET /calls?parentId=…`) and — with `bridgedTransferTranscribe` on — its
   transcript fill in as you speak.
4. Press `1` **from the engineer's phone** and confirm the follow-up agent
   answers with awareness of what was said. Press digits from the caller's
   phone first to confirm they do nothing.
5. Check the follow-up agent's booking call hits your API with the agreed
   slot, and that the final call-record chain is
   `original → bridged segment → follow-up`.
6. With a `summaryAgent` configured, check the follow-up call's invocation
   log shows `transfer_summary` returning `status: "ready"` with a sensible
   summary (and that a slow summariser yields `pending` then `ready` on the
   retry, never a stalled takeover).
7. With recording enabled on the original agent (sipbridge topology), check
   the bridged-segment record gains a `recordingId` and plays back as stereo
   with the caller on the left and the engineer on the right.

## Caveats

- **The engineer must press the key while still on the call.** Hanging up
  without pressing ends the call normally — there is no hand-back after the
  bridge is gone.
- **Bridged means billed**: forcing the bridged path keeps the platform (and
  per-minute charges) in the call for the human↔human segment, unlike a
  REFER hand-off.
- **Transcription is best-effort**: an STT failure never disturbs the live
  bridge; the follow-up agent then sees the "was not recorded" note instead
  of the second section — prompt it to ask the caller what was agreed as a
  fallback (the example prompt's confirmation step covers this).
- **Busy follow-up agent**: the takeover aborts and leaves the humans
  connected; the engineer can press the key again.
- **Not available for WebRTC (browser) callers** — see the
  [topology table](./call-transfers.md#topology-support).
- Keys are matched with the `dtmfTimeout` inter-digit window (default
  1500 ms); avoid making one key a prefix of another (`"1"` and `"12"`)
  unless you understand the [timeout disambiguation](./call-transfers.md#human-to-agent-transfers-bridgedtransfertoagent).
