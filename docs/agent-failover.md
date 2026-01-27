# Agent Failover

This document describes how to configure and use agent failover, a feature that allows automatic fallback to alternative agents, models, or phone numbers when the primary agent or model fails to start or connect.

## Overview

Agent failover provides resilience by automatically switching to backup options when the primary agent encounters setup failures (such as model connection timeouts, unsupported models, or initialization errors). The failover system supports three levels of fallback, applied in a strict precedence order:

1. **Agent-level fallback**: Switch to a completely different agent configuration
2. **Model-level fallback**: Retry with a different model using the same agent configuration
3. **Number-level fallback**: Transfer the call to a phone number or endpoint

Failover is only triggered for **setup-time failures** (before the call starts). Runtime errors during an active call do not trigger failover, as the agent is already running and handling the conversation.

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

3. **Number Fallback** (`options.fallback.number`)
   - If neither agent nor model fallback is configured (or they fail), the call is transferred
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

Failover only operates on Livekit agents, it does not operate on legacy Jambonz agents, nor does it work on platform specific (e.g. Ultravox) WebRTC agents.



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
      "number": "+441234567890"
    }
  }
}
```

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

## Best Practices

1. **Test Your Fallback Chain**: Ensure your fallback agents/models are properly configured and tested
2. **Use Appropriate Fallbacks**: 
   - Agent fallback for completely different agents, where each agent definition (prompt) is tuned to the model provider
   - Model fallback where a single agent definition is known to work well with two different providers/models
   - Number fallback as a last resort to human operators
3. **Avoid Circular References**: Don't create fallback chains that reference each other
4. **Consider Costs**: Each fallback attempt may incur LLM costs, different models have different token or per minute costs

## API Reference

For complete API documentation, see the [Swagger API documentation](https://llm.aplisay.com/api).

### Agent Options Schema

The `options.fallback` object supports the following properties:

- `agent` (string, optional): UUID of a fallback agent
- `model` (string, optional): Model name for fallback (e.g., `"livekit:openai/gpt-4.1-mini"`)
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

### Transfer Fallback Not Working

- **Verify number format**: Use E.164 format (e.g., `+441234567890`) or valid endpoint ID
- **Check outbound calling**: Ensure outbound calling is enabled for the provider trunk
- **Review transfer documentation**: See [Call Transfers](./call-transfers.md) for transfer requirements
