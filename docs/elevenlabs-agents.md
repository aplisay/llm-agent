# ElevenLabs Agents

ElevenLabs Agents is ElevenLabs's hosted voice agent: speech recognition, a
large language model of your choice, ElevenLabs text-to-speech and turn-taking
run together on the ElevenLabs side, over one WebSocket. The platform offers
it as realtime rows on both voice workers, one row per LLM:

| Pipecat row | LiveKit row | LLM behind the agent |
|---|---|---|
| `pipecat:elevenlabs/gemini-2.5-flash` | `livekit:elevenlabs/gemini-2.5-flash` | Google Gemini 2.5 Flash |
| `pipecat:elevenlabs/gpt-5.4-mini` | `livekit:elevenlabs/gpt-5.4-mini` | OpenAI GPT-5.4 mini |
| `pipecat:elevenlabs/claude-haiku-5-5` | `livekit:elevenlabs/claude-haiku-5-5` | Anthropic Claude Haiku 5.5 |
| `pipecat:elevenlabs/claude-sonnet-5-5` | `livekit:elevenlabs/claude-sonnet-5-5` | Anthropic Claude Sonnet 5.5 |

The two rows of an LLM behave the same except where
[On the LiveKit worker](#on-the-livekit-worker) says otherwise. They need
`ELEVENLABS_API_KEY` on the API server (for the voice list) and on the
worker (for the conversation). It is the same key the ElevenLabs TTS vendor
uses on pipeline rows.

## How a call runs

An ElevenLabs conversation runs against an *agent* object held in the
ElevenLabs workspace. Creating one takes a few seconds, far too long to do per
call, so the worker keeps one ElevenLabs agent per **configuration** and reuses
it:

- The configuration is everything a conversation cannot change: the LLM, the
  tools (every function, builtin and MCP tool as an ElevenLabs *client tool*),
  the TTS model, the turn settings, the audio formats, the privacy settings
  and anything in `vendorSpecific.elevenlabs`. It is hashed, and the hash is
  the agent's name (`<prefix>:<hash>`).
- At call start the worker looks the name up (about 200 ms), creates the agent
  if it is missing (about 3 s, once per new configuration), then asks for a
  signed URL and opens the conversation.
- The per-call values go as conversation overrides: the prompt (with its
  metadata already filled in), the greeting, the voice, the speaking rate, the
  language and the duration cap.

Any number of platform agents that share a configuration share one ElevenLabs
agent. The ElevenLabs agents carry the tag `aplisay` and the deployment's
prefix, so `scripts/prune-elevenlabs-agents.mjs` can remove the ones a changed
configuration left behind.

Every ElevenLabs agent the worker creates requires a signed URL to join
(`enable_auth`), so knowing an agent id gives nobody a conversation.

### Greeting and opening

`greeting.text` becomes the conversation's `first_message`: ElevenLabs speaks
it word for word, about 300 ms after the conversation opens. Everything else
is an instruction the worker sends as the first user-side message once the
conversation is ready, so the agent opens in its own words:
`greeting.instructions`, the platform's default opening when no greeting is
set, and the handover and takeover openings after a `transfer_agent` or a
human hand-back. The caller's audio is held until the greeting has been
spoken, as on the other rows.

### Transcript

The agent's text for each reply arrives in one piece. The worker logs it when
the reply ends, and when the caller interrupts it logs the text ElevenLabs
reports as actually spoken (its `agent_response_correction`), so the `agent`
rows show what the caller heard. ElevenLabs's expressive models sometimes
emit audio tags such as `[warm]` in the text; they are stripped from the
transcript. Caller transcripts are final only; there are no interim rows.

## Options on the rows

| Option | Behaviour |
|---|---|
| `greeting.text` | Spoken exactly as the conversation's first message. |
| `greeting.instructions` | A first message in the agent's own words, from the instructions. |
| no greeting | The platform's opening instruction, so the agent still speaks first. |
| `inactivity` | The platform's idle detection. The message is sent as an instruction to say it exactly; wording is best-effort. Repeat count and `hangup` unchanged. |
| `maxDuration` | The worker's hard stop, unchanged, and a minute more as the ElevenLabs cap. ElevenLabs caps a conversation at **two hours** whatever `maxDuration` says. |
| `dtmfTimeout`, `dtmfTerminator` | Digits go to ElevenLabs as keypad input and are logged as a `user` row. |
| functions, builtins | Client tools run in the worker. ElevenLabs waits for each result, up to 120 s. |
| MCP servers | The worker is the MCP client and exposes MCP tools as client tools. ElevenLabs's own MCP integrations and knowledge bases are not used. |
| `transfer_agent` | A full restart of the agent stack: the new agent's configuration may be a different ElevenLabs agent. The conversation so far is carried in the new prompt. |
| Blind, consultative and bridged transfers | Unchanged. |
| `stt.aux`, `tts.output`, `recording`, `fallback.*` | Unchanged. |
| `tts.voice` | An ElevenLabs voice id from the catalogue; default `cjVigY5qzO86Huf0OWal`. |
| `tts.vendor` | Must be unset or `elevenlabs`. There is no text-output mode (see below). |
| `tts.speed` | ElevenLabs's 0.7 to 1.2 range (docs/tts-speed.md). |
| `tts.language`, `stt.language` | The primary subtag (`en-GB` -> `en`) is the conversation's language. Unset leaves the agent's default, English. |
| `temperature`, `maxTokens` | Passed to the LLM through the ElevenLabs agent. |
| `effort` | Ignored. Set `agent.prompt.reasoning_effort` through `vendorSpecific` where the LLM supports it. |
| `voiceMode` | Must be `realtime` or unset. |

### No text-output mode

ElevenLabs's text-only conversation mode takes text in as well as out, so the
rows cannot run with an external TTS. They report `hasExternalTts: false`, and
`options.tts.vendor` must be unset or `elevenlabs`. See
[realtime-external-tts.md](realtime-external-tts.md).

### Voices

`GET /models/pipecat:elevenlabs/<llm>/voices/{locale}` lists the ElevenLabs
catalogue under the `elevenlabs` vendor, keyed by the locale each voice's
accent label gives (`en-GB`, `en-US`, ...), the same list the pipeline rows
offer. `options.tts.voice` is the voice id and is validated against it when
the agent is saved. Voices are not tied to a language: the agent speaks the
conversation's language with whichever voice is chosen.

### `vendorSpecific.elevenlabs.conversation_config`

A free-form object deep-merged into the ElevenLabs agent's
`conversation_config` after the platform's own mapping, so an explicit value
here wins. It is part of the configuration hash, so changing it means a new
ElevenLabs agent on the next call. Useful fields:

```json
{
  "vendorSpecific": {
    "elevenlabs": {
      "conversation_config": {
        "turn": { "turn_eagerness": "eager", "turn_timeout": 10 },
        "tts": { "model_id": "eleven_turbo_v2_5", "stability": 0.4, "similarity_boost": 0.8 },
        "asr": { "keywords": ["Aplisay"] },
        "agent": { "prompt": { "reasoning_effort": "low" } }
      }
    }
  }
}
```

- `turn`: ElevenLabs's turn-taking (`turn_eagerness`, `turn_timeout`,
  `turn_model`, the interruption settings). `turn_timeout` is the silence
  after which the agent re-engages by itself; the platform sets it to 300 s
  so that `options.inactivity` speaks first.
- `tts`: the TTS model (`eleven_v4_turbo` by default), `stability`,
  `similarity_boost`, pronunciation dictionaries. ElevenLabs refuses some
  models for some languages (an English agent cannot use `eleven_flash_v2_5`,
  for example); the refusal surfaces as a failed call start, which takes the
  fallback path.
- `asr`: `keywords` and `quality`.
- `agent.prompt`: LLM settings such as `reasoning_effort`.

Not accepted, and refused when the agent is saved: the prompt, the LLM, the
tools (`tools`, `tool_ids`, `built_in_tools`, `mcp_server_ids`,
`knowledge_base`, `custom_llm`), `first_message`, `tts.voice_id`, the audio
formats, `client_events`, `text_only` and `max_duration_seconds`. The platform
sets all of them. `platform_settings` (auth, privacy) is the platform's too.

### Reserved function names

ElevenLabs reserves `end_call`, `language_detection`, `skip_turn`,
`transfer_to_agent`, `transfer_to_number`, `voicemail_detection` and
`play_keypad_touch_tone` for its system tools. A function with one of those
names on an ElevenLabs row is rejected when the agent is saved. The platform
never enables the system tools; use the `hangup` and `transfer` builtins.

## On the LiveKit worker

The LiveKit rows run the same hosted agents (the configuration and its hash
are built the same way, so a configuration shared by the two workers shares
one ElevenLabs agent) and take the same options. The differences:

- The transcript after a barge-in comes from the LiveKit SDK's playback
  position, not from ElevenLabs's own correction, so it is an estimate of what
  the caller heard rather than ElevenLabs's account of it.
- The inactivity message and the keypad digits reach the agent the way they
  do on the other LiveKit realtime rows: an instruction to say the message
  exactly, and the digits as keypad input.
- MCP servers are not honoured on any LiveKit row, including these.

## Usage and billing

ElevenLabs bills a conversation per minute and passes the LLM's cost through,
so each row is billed per minute of call on the call's `voice` row, priced by
the row's minute line (`model:pipecat:elevenlabs/<llm>` or
`model:livekit:elevenlabs/<llm>` in the rate-component catalogue). The agent's speech is not metered as `tts`: ElevenLabs is also a
discrete TTS vendor, and a `tts|elevenlabs` row would be priced by that line
on top of the minute. No token rows are recorded; ElevenLabs reports none
over the conversation.

`scripts/add-elevenlabs-rate-lines.mjs` seeds the minute lines for the rows
of both workers on the default card and on every bespoke card that prices
models, at
`ELEVENLABS_VOICE_PRICE_MICROS` micro-pence per minute. Without the override
it copies the card's Ultravox minute price as a placeholder, which is below
what ElevenLabs charges; set the real price per card and per LLM where they
differ.

## Data retention

The ElevenLabs agents the worker creates keep no audio (`record_voice` off)
and one day of conversation metadata. Transcripts and recordings are the
platform's own. ElevenLabs's regional endpoints are reachable with
`ELEVENLABS_API_BASE` on the worker (default `https://api.elevenlabs.io`).

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | API server and both workers | The ElevenLabs key. `ELEVEN_API_KEY` is accepted on the workers. |
| `ELEVENLABS_AGENT_PREFIX` | Both workers | The first segment of every ElevenLabs agent name the worker creates (default `aplisay`). Give each deployment sharing a workspace its own. |
| `ELEVENLABS_API_BASE` | Both workers | The REST base, for a regional endpoint. |

## Limits and caveats

- A conversation lasts at most two hours; the provider closes it and the call
  ends with a provider reason.
- The first call on a new configuration waits about three seconds while the
  ElevenLabs agent is created. Later calls pay one signed-URL request.
- Changing a function's description, an MCP server's tool list, or anything
  under `vendorSpecific.elevenlabs` makes a new configuration, and so a new
  ElevenLabs agent. Run `scripts/prune-elevenlabs-agents.mjs` now and then to
  delete the agents (and their tools) nothing has used for a while.
- Concurrent conversations are limited by the ElevenLabs plan. Over the limit
  the conversation is refused at start and the call takes the platform's
  fallback path like any provider failure.
- Tool results are returned as they finish; the conversation waits for them.
  A tool that takes longer than 120 s is reported to the agent as timed out.
