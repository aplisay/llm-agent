# Uninterruptible greetings

This document describes how to configure an **uninterruptible opening greeting** via the public API, and what behaviour to expect for different model stacks.

## Goal

Play an opening greeting immediately after the session connects such that:

- The caller cannot barge-in and truncate the greeting.
- Caller audio during greeting is **not buffered/replayed** afterwards (we intentionally drop it).
- After the greeting finishes, the agent proceeds normally.

## API / configuration

See `AgentOptions.greeting` in our API docs (`api/api-doc.yaml`).

Use the portable `AgentOptions.greeting` block:

- `options.greeting.text`: fixed greeting text
- `options.greeting.instructions`: LLM-driven greeting instructions

Exactly one of `text` or `instructions` should be set.

Example (fixed text):

```json
{
  "options": {
    "greeting": { "text": "Hello. How can I help you today?" }
  }
}
```

Example (instructions):

```json
{
  "options": {
    "greeting": { "instructions": "Greet the caller briefly and ask how you can help." }
  }
}
```

Recommendations:

- Prefer `greeting.text` for short, literal greetings (no embedded instructions).
- Prefer `greeting.instructions` when you want the model to decide wording while remaining uninterruptible.


## Behaviour quirks by model stack

This feature is only available the through the Livekit, an ultravox pipeline agents (all `livekit:` handler prefixed models, and Ultravox `ultravox:` prefixed WebRTC models only). It is a no-op on Jambonz telephony agents.

Within that group of implementations, most models (Ultravox, plus all pipeline agents) should reasonably reliably output an `options.greeting.text` verbatim. The only exception is...

### LiveKit realtime: OpenAI (`livekit:openai/...`)

- **Uninterruptible**: the greeting is treated as non-interruptible (no barge-in truncation).
- **Caller speech during greeting**: is **dropped**, not buffered/replayed after the greeting.

**Important note for `greeting.text`**:

Even though `greeting.text` is “fixed text”, OpenAI realtime still produces speech through the realtime model. Treat it as **best-effort verbatim**, not a guaranteed “speak exactly these characters” primitive.


## Dropping early caller audio during greeting

**caller audio during the greeting is dropped**, not buffered/replayed.
This means the agent is intentionally “deaf” until the greeting completes.
