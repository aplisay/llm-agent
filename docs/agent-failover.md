# Agent Failover

This document describes how to configure and use agent failover, a feature that allows automatic fallback to alternative agents, models, a spoken announcement, or phone numbers when the primary agent or model fails to start or connect.

## Overview

Agent failover provides resilience by automatically switching to backup options when the primary agent encounters setup failures (such as model connection timeouts, unsupported models, or initialization errors). The failover system supports four levels of fallback, applied in a strict precedence order:

1. **Agent-level fallback**: Switch to a completely different agent configuration
2. **Model-level fallback**: Retry with a different model using the same agent configuration
3. **Message-level fallback**: Speak a fixed announcement to the caller, then end the call
4. **Number-level fallback**: Transfer the call to a phone number or endpoint

Failover is only triggered for **setup-time failures** (before the call starts). Runtime errors during an active call do not trigger failover, as the agent is already running and handling the conversation.

The chain stops at the first level that works. A level that is not configured, or that fails, falls through to the next.

## How Failover Works

When an agent fails to start (e.g., model connection timeout, unsupported model, or initialization error), the system checks for configured fallback options in the following order:

### Precedence Order

1. **Agent Fallback** (`options.fallback.agent`)
   - If specified, the system fetches the fallback agent by ID
   - The entire agent session is restarted with the new agent
   - All agent properties are replaced (prompt, functions, options, etc.)
   - Further fallback decisions are controlled by the **new agent's** `options.fallback` configuration
   - This is the highest priority fallback

2. **Model Fallback** (`options.fallback.model`)
   - If no agent fallback is configured (or it fails), the system retries with a different model
   - This model does not need to (probably shouldn't!) use the same vendor, failover can therefore be directed at an entirely different model
   - Only the `modelName` is changed; all other agent properties remain the same
   - The session is restarted with the fallback model
   - This is the second priority fallback

3. **Message Fallback** (`options.fallback.message`)
   - If no agent or model fallback is configured (or they have failed), a fixed announcement is spoken to the caller
   - The audio is synthesised once and cached, so repeat playouts make no TTS vendor call — see [Fixed message fallback](#fixed-message-fallback)
   - Terminal on success: once the caller has heard the announcement the call ends, and `number` is not attempted
   - Reached directly, skipping `agent` and `model`, when the failure is an agent concurrency limit

4. **Number Fallback** (`options.fallback.number`)
   - If none of the above is configured (or they fail), the call is transferred
   - The system performs a blind transfer to the specified phone number or endpoint ID
   - The transfer uses the same mechanisms as the builtin `transfer` function, this is a bridged transfer by default.
   - This is the final fallback option

### When Failover is Triggered

Failover is **only** triggered for errors that occur during agent setup, before the call starts:

- Model connection timeouts
- Unsupported model errors
- Model initialization failures
- Session creation failures
- Any error during `runAgentWorker` setup phase

Failover is **not** triggered for:
- Runtime errors during an active conversation
- Function call failures
- Transfer failures (these are handled by the transfer system)
- Normal call completion

### Limitations

Whilst failover can be used to provide resilience by failing over to other model vendors or blind transferring calls to a phone number,
this is only useful to recover from failure of a single LLM vendor to accept a call.

If the Aplisay platform itself is degraded by e.g. a Livekit failure then it is likely that the failover option will be of limited use.

Failover operates on the LiveKit and Pipecat agent runtimes. It does not operate on legacy Jambonz agents, nor on platform-specific (e.g. native Ultravox) WebRTC agents — those stacks own their own session lifecycle and never enter the fallback chain.

#### Voices

When using model-level fallback (`options.fallback.model`), the voice configuration from the primary agent is preserved. However, if the fallback model uses a different vendor, the same voice may not be available on that vendor's platform. In such cases, the vendor's default voice will be used instead.

For example:
- Primary agent uses `livekit:ultravox/ultravox-v0.7` with voice `"Svetlana"`
- Fallback model is `livekit:openai/gpt-realtime`
- OpenAI's realtime API doesn't have a voice named `"Svetlana"`, so it will use OpenAI's default voice

**Workaround:** To maintain voice consistency across failover, use agent-level fallback (`options.fallback.agent`) instead of model-level fallback. Each agent can be configured with a voice appropriate for its model vendor.

**Future improvements:** This limitation may be resolved in future versions by:
- Supporting the same custom voice across vendors
- Allowing fallback-specific voice options in the `options.fallback` configuration

## Configuration

### API Configuration

Failover options are configured in the `options.fallback` object when creating or updating an agent via the API.

#### Agent Fallback

To configure an agent-level fallback, specify the ID of another agent:

```json
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "prompt": "You are a helpful assistant.",
  "options": {
    "fallback": {
      "agent": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

The fallback agent must already exist. When the primary agent fails, the system will:
- Fetch the fallback agent by ID
- Restart the session with the fallback agent's configuration
- Use the fallback agent's own `options.fallback` for any further fallback decisions

#### Model Fallback

To configure a model-level fallback, specify a different model name:

```json
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "prompt": "You are a helpful assistant.",
  "options": {
    "fallback": {
      "model": "livekit:openai/gpt-realtime"
    }
  }
}
```

When the primary model fails, the system will:
- Retry with the fallback model
- Keep all other agent properties unchanged (prompt, functions, options, etc.)
- Only the `modelName` is substituted

#### Message Fallback

To configure a spoken announcement, set `options.fallback.message`. It always takes an object; `text` is the only required field, and on its own means "say this in the agent's own voice":

```json
{
  "modelName": "livekit:openai/gpt-4o",
  "prompt": "You are a helpful assistant.",
  "options": {
    "tts": { "vendor": "elevenlabs", "voice": "Dominus" },
    "fallback": {
      "message": {
        "text": "Sorry, we are unusually busy right now. Please call back shortly."
      }
    }
  }
}
```

There is deliberately no bare-string shorthand. `message: "..."` is rejected rather than accepted as `{ text }`: one shape to document, validate, and read is worth a few extra characters.

Adding `vendor` / `voice` has the announcement spoken by a different TTS from the agent's own:

```json
{
  "modelName": "livekit:openai/gpt-4o",
  "prompt": "You are a helpful assistant.",
  "options": {
    "tts": { "vendor": "elevenlabs", "voice": "Dominus" },
    "fallback": {
      "message": {
        "text": "Sorry, we are unusually busy right now. Please call back shortly.",
        "vendor": "deepgram/aura-2",
        "voice": "thalia",
        "language": "en-GB"
      }
    }
  }
}
```

For a **pipeline** agent (STT–LLM–TTS), `vendor`, `voice`, and `language` each default to the corresponding `options.tts` value, so you only state what you want to differ. Overriding them is worth doing when the agent's own TTS stack is a plausible cause of the failure you are protecting against — pointing the announcement at a vendor you have no dependency on elsewhere keeps it playable in precisely the circumstances it exists for.

For a **realtime** agent the defaults work differently — see [Realtime agents](#realtime-agents-ultravox-openai-realtime-gemini-live) below.

`text` is required and limited to 1000 characters. `voice` and `vendor` are validated when the agent is saved, against the catalogue of voices and vendors a *TTS* can render — not against the agent model's own voices, which for a realtime model are timbres of the model rather than anything a TTS could produce. Validating at write time is deliberate: a typo that only surfaced during an outage would be a fallback that isn't one.

#### Number Fallback

To configure a number-level fallback (transfer), specify a phone number or endpoint ID:

```json
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "prompt": "You are a helpful assistant.",
  "options": {
    "fallback": {
      "number": "+441234567890"
    }
  }
}
```

When all higher-priority fallbacks are exhausted or unavailable, the system will:
- Perform a blind transfer to the specified number
- The transfer uses the same mechanisms as the builtin `transfer` function
- The call lifecycle is managed by the transfer system

#### Combined Fallback Configuration

You can configure multiple fallback levels:

```json
{
  "modelName": "livekit:openai/gpt-4o",
  "prompt": "You are a helpful assistant.",
  "options": {
    "fallback": {
      "agent": "550e8400-e29b-41d4-a716-446655440000",
      "model": "livekit:openai/gpt-realtime",
      "message": { "text": "Sorry, we cannot take your call right now. Please try again shortly." },
      "number": "+441234567890"
    }
  }
}
```

Note that with both `message` and `number` set, the announcement wins: it is higher precedence, and it is terminal on success, so `number` is only reached if the announcement could not be played at all. If what you want is "announce, then transfer", that is not this option — configure `number` alone and use the transfer's own prompting.

In this example:
1. If the primary agent fails, try the fallback agent
2. If the fallback agent also fails (or if agent fallback wasn't triggered), try the fallback model
3. If the fallback model also fails, transfer to the fallback number

### Example: Creating an Agent with Failover

```bash
curl -X POST https://llm-agent.aplisay.com/api/agents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "modelName": "livekit:openai/gpt-4o",
    "prompt": "You are a customer service agent.",
    "options": {
      "temperature": 0.7,
      "fallback": {
        "model": "livekit:openai/gpt-4.1-mini",
        "number": "+441234567890"
      }
    }
  }'
```

### Example: Updating an Agent to Add Failover

```bash
curl -X PUT https://llm-agent.aplisay.com/api/agents/{agentId} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "options": {
      "temperature": 0.7,
      "fallback": {
        "model": "livekit:openai/gpt-realtime",
        "number": "+441234567890"
      }
    }
  }'
```

## Fixed message fallback

The message fallback exists for the case where every other option is either unavailable or inappropriate: there is no spare agent, no alternative model, and nobody to transfer to — but the caller is on the line and deserves better than dead air or a busy tone.

### The audio is synthesised once, then cached

An announcement cannot vary for a given configuration, so it is rendered once and stored in Google Cloud Storage under a key derived from its own content. Every later playout replays that recording.

- **The first call that needs a given announcement pays for it.** That call synthesises through the configured TTS and is metered for the characters in the normal way.
- **Every later call is free.** A cache hit calls no vendor, so it meters nothing. An announcement is therefore billed once per distinct configuration, not once per failed call — which matters, because failures arrive in bursts.
- **Editing the message re-synthesises automatically.** The cache key is a digest of the text, vendor, voice, and language. Change any of them and the next call misses, re-renders, and stores the new audio. There is nothing to invalidate by hand and no way to serve stale audio for edited text.
- **Identical announcements are shared.** Two agents configured with the same words in the same voice resolve to the same object. The content is fully determined by the key, so this leaks nothing between tenants, and the bucket is platform-private.

Storage lives alongside call recordings — the same bucket, its own prefix — so it inherits the credentials and lifecycle management already in place. Unlike recordings, the cached audio is **not** encrypted. There would be nothing to protect (it is a rendering of `options.fallback.message.text`, which sits in clear in the agent record) and decrypting it would burn CPU at the worst possible moment, since heavy load is one of the likelier reasons an agent session failed in the first place. The playout path is deliberately kept to a download, a resample, and a write. The full storage contract is in `lib/fallback-message/CONTRACT.md`.

### Realtime agents (Ultravox, OpenAI Realtime, Gemini Live)

A realtime speech-to-speech agent has no TTS. The model speaks for itself, and `options.tts.voice` names one of *its* voices — `"Svetlana"` on Ultravox, say — which no TTS service can render.

That matters here more than anywhere else, because the announcement plays precisely when the model could not be started. The model cannot be what speaks it, so a discrete TTS always does. Two consequences follow:

- **The model's voice and vendor are not inherited.** With no explicit override, the announcement is spoken by the worker's default TTS voice. (Inheriting would hand the TTS builder a vendor of `ultravox`, which does not fall back to anything — it raises `Unsupported TTS vendor` — so the announcement covering the outage would fail with it.)
- **`language` is still inherited**, because a BCP-47 tag means the same thing to a model and to a TTS, and an announcement in the wrong language is worse than one in an unfamiliar voice.

So if you care which voice a realtime agent's announcement uses — and you probably do, since it is the only voice the caller will hear — **state it explicitly**:

```json
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "options": {
    "tts": { "voice": "Svetlana" },
    "fallback": {
      "message": {
        "text": "Sorry, we cannot take your call right now. Please try again shortly.",
        "vendor": "elevenlabs",
        "voice": "Rachel"
      }
    }
  }
}
```

This is also the sturdiest configuration available, and worth considering even for pipeline agents: the announcement's vendor is then chosen independently of everything the agent depends on, so an outage at the agent's own provider cannot take the announcement with it.

Voice and vendor here are validated against the TTS catalogue, so an ElevenLabs voice on an Ultravox agent is accepted — it is the configuration that works.

### Concurrency limits

This is the case the message fallback is most useful for, and it behaves differently from the other failure modes.

When a call is refused because it would exceed an agent concurrency limit (on the instance, user, or organisation), the chain **skips `agent` and `model` and goes straight to `message`**:

- Retrying with a different agent or a different model cannot help. The limit is enforced when the call is started, whichever agent or model is behind it, so those attempts would spend setup time only to be refused identically.
- `number` cannot help either. Its transfer needs a started call, and starting one is exactly what the limiter refused.

Playing the announcement works where those do not, because **it never starts a call**. A cached announcement makes no vendor call, so there is no usage to record, so there is no call record to create, so no concurrency slot is reserved. This is essential rather than incidental: an announcement that consumed a slot would be spending the very capacity it is apologising for, and under sustained load would compete with the real calls it is meant to protect.

The consequence to be aware of is that **the call is answered**. Without a message configured, a concurrency rejection is signalled back as busy and the caller never connects. With one configured, the platform answers the leg in order to play the announcement, which means the caller is connected for those few seconds and any per-minute carrier cost for them is incurred. That is the trade an operator is asking for by configuring the option, and it is small — but it is a real change in behaviour, not merely an added courtesy.

If the announcement cannot be played (synthesis fails and there is no cached copy, or the media path is unavailable), the concurrency rejection is re-raised and the caller gets the busy signal exactly as before.

### What is recorded

The message fallback does not change how the underlying failure is recorded. The call keeps its real failure reason and remains diagnosable; the announcement is a courtesy played on the way out, not a different outcome. The seconds spent playing it are not recorded as call duration, because the call was never started.

### Failure behaviour

Every step of this path is non-fatal by design, because it only ever runs when something else has already broken:

| Failure | Result |
| --- | --- |
| Cache read fails or the object is corrupt | Re-synthesise for this call |
| Cache write fails | Announcement still plays; next call re-synthesises |
| Synthesis fails | Fall through to `fallback.number` (or, for a concurrency rejection, busy) |
| Playout fails | Fall through to `fallback.number` (or busy) |

## Failover Scenarios

### Scenario 1: Model Connection Timeout

**Setup:**

- Primary agent uses `livekit:ultravox/ultravox-v0.7`
- Fallback model: `livekit:openai/gpt-realtime`
- Fallback number: `+441234567890`

**What happens:**
1. Primary agent tries to connect to Ultravox 0.7 (GLM 4.6)
2. Connection times out (setup failure)
3. System retries with OpenAI realtime (model fallback)
4. If OpenAI realtime also fails, call is transferred to `+441234567890`

### Scenario 2: Unsupported Model

**Setup:**
- Primary agent uses an unsupported model
- Fallback agent: `550e8400-e29b-41d4-a716-446655440000`
- Fallback number: `+441234567890`

**What happens:**
1. Primary agent fails with "Unsupported model" error
2. System fetches and switches to fallback agent (agent fallback)
3. If fallback agent also fails, call is transferred to `+441234567890`

### Scenario 3: Complete Failover Chain

**Setup:**

- Primary agent: `livekit:ultravox/ultravox-v0.7`
- Fallback agent: `550e8400-e29b-41d4-a716-446655440000` (uses `livekit:openai/gpt-realtime`)
- Fallback agent fallback model: `livekit:ultravox/ultravox-v0.6-gemma3-27b`
- Fallback agent fallback number: `+441234567890`

**What happens:**
1. Primary agent fails
2. System switches to fallback agent (which uses Ultravox)
3. If fallback agent fails, system tries fallback model (livekit:ultravox/ultravox-v0.6-gemma3-27b) configured in fallback agent
4. If fallback model fails, call is transferred to `+441234567890`

### Scenario 4: All Agents Busy (Concurrency Limit)

**Setup:**

- Organisation `agentLimit` is 10, and 10 calls are already in progress
- Fallback message: `"Sorry, we are unusually busy right now. Please call back shortly."`
- Fallback model and number are also configured

**What happens:**
1. An eleventh call arrives and is refused by the concurrency limiter
2. Agent and model fallback are **skipped** — the limit applies whichever model would run
3. The announcement is played from cache; no call is started and no concurrency slot is taken
4. The call ends. The number fallback is not attempted, because its transfer would need the slot that was just refused

Without `message` configured, step 2 onwards is replaced by an immediate busy rejection, which remains the behaviour if the announcement cannot be played.

## Best Practices

1. **Test Your Fallback Chain**: Ensure your fallback agents/models are properly configured and tested
2. **Use Appropriate Fallbacks**: 
   - Agent fallback for completely different agents, where each agent definition (prompt) is tuned to the model provider
   - Model fallback where a single agent definition is known to work well with two different providers/models
   - Message fallback to say something useful when there is no agent and no human to hand to — and as the only fallback that can serve a caller refused on a concurrency limit
   - Number fallback as a last resort to human operators
3. **Avoid Circular References**: Don't create fallback chains that reference each other
4. **Consider Costs**: Each fallback attempt may incur LLM costs, different models have different token or per minute costs

## API Reference

For complete API documentation, see the [Swagger API documentation](https://llm.aplisay.com/api).

### Agent Options Schema

The `options.fallback` object supports the following properties:

- `agent` (string, optional): UUID of a fallback agent
- `model` (string, optional): Model name for fallback (e.g., `"livekit:openai/gpt-4.1-mini"`)
- `message` (object, optional): Fixed announcement spoken to the caller. Takes `text` (required, max 1000 characters) plus optional `vendor`, `voice`, and `language`. There is no bare-string form. For a pipeline agent these default to the matching `options.tts` value; for a realtime agent only `language` is inherited, and the worker's default TTS voice is used unless `vendor`/`voice` are stated — see [Realtime agents](#realtime-agents-ultravox-openai-realtime-gemini-live)
- `number` (string, optional): Phone number or endpoint ID for fallback transfer (E.164 format or endpoint UUID)

All properties are optional, but at least one should be specified for failover to be useful.

### Related Documentation

- [Call Transfers](./call-transfers.md) - Details on the transfer mechanism used by number fallback
- [API Documentation](https://llm.aplisay.com/api) - Complete API reference
- [Agent Options Schema](https://llm.aplisay.com/api#/components/schemas/AgentOptions) - Full schema definition

## Troubleshooting

### Failover Not Triggering

- **Check error type**: Failover only triggers for setup-time failures, not runtime errors
- **Verify configuration**: Ensure `options.fallback` is properly set in the agent configuration
- **Check logs**: Look for "evaluating fallback options" messages in the logs

### Fallback Agent Not Found

- **Verify agent exists**: The fallback agent ID must reference an existing agent
- **Check permissions**: Ensure the fallback agent is accessible to the same user/organization

### Message Fallback Not Playing

- **Check the agent saved cleanly**: `voice` and `vendor` are validated against the model's TTS catalogue at write time; a rejected save means no message is configured at all
- **Check the text is non-empty**: whitespace-only `text` is treated as no message
- **Look for `playing fixed fallback message` in the logs**: its absence means the chain never reached this step (an `agent` or `model` fallback succeeded, or none was configured)
- **Check for `fixed fallback message unavailable`**: the step was reached but synthesis or playout failed, and the chain moved on
- **Check worker credentials for the storage bucket**: a cache read failure is logged and degrades to re-synthesis, so persistent re-synthesis of the same message points at the bucket rather than the TTS

### Message Fallback Plays But The Caller Was Expecting Busy

Configuring `options.fallback.message` deliberately answers calls that would otherwise be refused with a busy signal, including those refused on a concurrency limit. Remove the message to restore busy rejection. See [Concurrency limits](#concurrency-limits).

### Transfer Fallback Not Working

- **Verify number format**: Use E.164 format (e.g., `+441234567890`) or valid endpoint ID
- **Check outbound calling**: Ensure outbound calling is enabled for the provider trunk
- **Review transfer documentation**: See [Call Transfers](./call-transfers.md) for transfer requirements
