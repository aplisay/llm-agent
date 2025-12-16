# Call Hooks

This document describes how to configure and use call hooks to receive notifications when calls start and end. 
Call hooks allow you to collect and disseminate information with other systems when new calls asynchronously arrive at your listeners or get started outbound.
They allow you to be alerted when new conversations start, and close the loop when they end.

## Overview

Call hooks are HTTP callbacks that are automatically triggered when calls start or end. They enable you to:

- Track call events in external systems (CRM, analytics, logging)
- Trigger workflows based on call lifecycle
- Collect call transcripts and metadata
- Monitor agent performance and call quality

Call hooks can be configured at two levels:

1. **Agent-level**: Applies to all calls for a specific agent
2. **Listener-level**: Applies to calls for a specific listener instance (overrides agent-level configuration)

## Configuration

### Basic Setup

Call hooks are configured using a `callHook` object that can be placed in:

- **Agent options**: `agent.options.callHook` - applies to all calls for this agent
- **Listener options**: `listener.options.callHook` - applies only to calls for this listener instance

The listener-level configuration takes precedence over agent-level configuration. If neither is configured, no callbacks are sent.

### Configuration Schema

```json
{
  "url": "https://app.example.com/call-hook",
  "hashKey": "optional-secret-key",
  "includeTranscript": false,
  "events": ["start", "end"]
}
```

#### Configuration Properties

- **`url`** (required): The URL to POST callback payloads to. Must be a valid HTTP/HTTPS endpoint.
- **`hashKey`** (optional): A shared secret used to compute a request integrity hash. If provided, the callback payload will include a `hash` field that can be used to verify the request authenticity.
- **`includeTranscript`** (optional, default: `false`): When set to `true`, the `end` event callback will include a `transcript` field containing the call transcript if available.
- **`events`** (optional, default: `["start", "end"]`): Array specifying which events should trigger callbacks. Valid values are `"start"` and `"end"`. If omitted or empty, both events are triggered.

## Examples

### Agent-Level Configuration

Configure a call hook for all calls to a specific agent:

```json
{
  "modelName": "gpt-4",
  "prompt": "You are a helpful assistant...",
  "options": {
    "callHook": {
      "url": "https://api.myapp.com/call-events",
      "hashKey": "my-secret-key-12345",
      "includeTranscript": true,
      "events": ["start", "end"]
    }
  }
}
```

When creating an agent via the API:

```bash
curl -X POST https://llm-agent.aplisay.com/api/agents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "modelName": "gpt-4",
    "prompt": "You are a helpful assistant...",
    "options": {
      "callHook": {
        "url": "https://api.myapp.com/call-events",
        "hashKey": "my-secret-key-12345",
        "includeTranscript": true
      }
    }
  }'
```

### Listener-Level Configuration

Configure a call hook for a specific listener instance (overrides agent-level configuration):

```bash
curl -X POST https://llm-agent.aplisay.com/api/agents/{agentId}/listen \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "number": "+442080996945",
    "options": {
      "callHook": {
        "url": "https://api.myapp.com/listener-call-events",
        "includeTranscript": true,
        "events": ["end"]
      }
    }
  }'
```

In this example, only `end` events will trigger callbacks for this specific listener, even if the agent-level configuration includes both `start` and `end`.

### Event Filtering

To receive only start events:

```json
{
  "callHook": {
    "url": "https://api.myapp.com/call-start",
    "events": ["start"]
  }
}
```

To receive only end events:

```json
{
  "callHook": {
    "url": "https://api.myapp.com/call-end",
    "events": ["end"],
    "includeTranscript": true
  }
}
```

## Callback Payload

When a call hook is triggered, a POST request is sent to the configured URL with a JSON payload.

### Start Event Payload

```json
{
  "event": "start",
  "callId": "648aa45d-204a-4c0c-a1e1-419406254134",
  "agentId": "648aa45d-204a-4c0c-a1e1-419406252234",
  "listenerId": "5a5c9a6b-bb8b-4dd9-a8ff-f179b0f3f777",
  "callerId": "+443300889471",
  "calledId": "+442080996945",
  "timestamp": "2025-06-04T12:00:00.000Z",
  "hash": "aef1f2e6d3c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3"
}
```

### End Event Payload

```json
{
  "event": "end",
  "callId": "648aa45d-204a-4c0c-a1e1-419406254134",
  "agentId": "648aa45d-204a-4c0c-a1e1-419406252234",
  "listenerId": "5a5c9a6b-bb8b-4dd9-a8ff-f179b0f3f777",
  "callerId": "+443300889471",
  "calledId": "+442080996945",
  "timestamp": "2025-06-04T12:01:00.000Z",
  "reason": "normal_hangup",
  "durationSeconds": 60,
  "transcript": {
    "entries": [
      {
        "type": "user",
        "data": "Hello, I need help with my order",
        "isFinal": true,
        "createdAt": "2025-06-04T12:00:05.000Z"
      },
      {
        "type": "agent",
        "data": "I'd be happy to help you with your order. Can you provide your order number?",
        "isFinal": true,
        "createdAt": "2025-06-04T12:00:08.000Z"
      }
    ]
  },
  "hash": "aef1f2e6d3c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3"
}
```

### Payload Fields

All payloads include:

- **`event`**: Either `"start"` or `"end"`
- **`callId`**: Unique identifier for the call
- **`agentId`**: ID of the agent handling the call (if available)
- **`listenerId`**: ID of the listener/instance (if available)
- **`callerId`**: Phone number or identifier of the caller
- **`calledId`**: Phone number or identifier that was called
- **`timestamp`**: ISO 8601 timestamp when the callback was generated
- **`hash`**: HMAC-SHA256 hash for request verification (only present if `hashKey` is configured)

End event payloads additionally include:

- **`reason`**: Optional reason for call end (e.g., `"normal_hangup"`, `"error"`)
- **`durationSeconds`**: Call duration in seconds (if available)
- **`transcript`**: Call transcript object (only if `includeTranscript` is `true` and transcript is available)

### Transcript Structure

When `includeTranscript` is enabled, the transcript is provided as an object with an `entries` array:

```json
{
  "entries": [
    {
      "type": "user",
      "data": "User's spoken text",
      "isFinal": true,
      "createdAt": "2025-06-04T12:00:05.000Z"
    },
    {
      "type": "agent",
      "data": "Agent's response text",
      "isFinal": true,
      "createdAt": "2025-06-04T12:00:08.000Z"
    }
  ]
}
```

Each entry contains:

- **`type`**: The type of log entry (`"user"`, `"agent"`, `"call"`, `"hangup"`, etc.)
- **`data`**: The text or data associated with the entry
- **`isFinal`**: Whether this is the final version of the entry (may be `false` for partial transcriptions)
- **`createdAt`**: ISO 8601 timestamp when the entry was created

## Request Verification

If you configure a `hashKey`, the callback payload will include a `hash` field that can be used to verify the request authenticity.

### Hash Computation

The hash is computed as HMAC-SHA256 over the canonical string:

```
hashKey|callId|listenerId|agentId
```

Where:
- `hashKey` is your configured secret key
- `callId` is the call identifier
- `listenerId` is the listener/instance ID (empty string if not available)
- `agentId` is the agent ID (empty string if not available)

The fields are joined with pipe (`|`) characters, and the resulting hash is represented as a hexadecimal string.

### Verification Example (Node.js)

```javascript
const crypto = require('crypto');

function verifyCallHookHash(payload, hashKey) {
  const canonical = `${hashKey}|${payload.callId}|${payload.listenerId || ''}|${payload.agentId || ''}`;
  const hmac = crypto.createHmac('sha256', hashKey);
  hmac.update(canonical);
  const expectedHash = hmac.digest('hex');
  
  return payload.hash === expectedHash;
}

// In your webhook handler
app.post('/call-hook', (req, res) => {
  const payload = req.body;
  const hashKey = process.env.CALL_HOOK_SECRET;
  
  if (hashKey && !verifyCallHookHash(payload, hashKey)) {
    return res.status(401).send('Invalid hash');
  }
  
  // Process the callback
  console.log(`Call ${payload.event}: ${payload.callId}`);
  res.status(200).send('OK');
});
```

### Verification Example (Python)

```python
import hmac
import hashlib

def verify_call_hook_hash(payload, hash_key):
    canonical = f"{hash_key}|{payload['callId']}|{payload.get('listenerId', '')}|{payload.get('agentId', '')}"
    expected_hash = hmac.new(
        hash_key.encode('utf-8'),
        canonical.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    return payload.get('hash') == expected_hash

# In your webhook handler
@app.route('/call-hook', methods=['POST'])
def call_hook():
    payload = request.json
    hash_key = os.environ.get('CALL_HOOK_SECRET')
    
    if hash_key and not verify_call_hook_hash(payload, hash_key):
        return 'Invalid hash', 401
    
    # Process the callback
    print(f"Call {payload['event']}: {payload['callId']}")
    return 'OK', 200
```

## Implementation Notes

### Callback Delivery

- Callbacks are sent asynchronously and do not block call processing
- If a callback fails (network error, timeout, etc.), it is logged but does not affect the call
- Callbacks have a 5-second timeout
- The system does not retry failed callbacks automatically

### Transcript Availability

Transcripts are included in end event callbacks when:

1. `includeTranscript` is set to `true` in the call hook configuration
2. The transcript is available for the call

For some call flows (notably Livekit agent-db calls), the transcript may be provided directly in the call end API request. In other cases, the transcript is lazily fetched from the transaction log database when needed.

If a transcript is not available, the `transcript` field will be omitted from the payload (not set to `null`).

### Event Timing

- **Start events**: Triggered when a call is marked as started. For different agent types:
  - **Livekit agent-db**: When `POST /api/agent-db/call/{callId}/start` is called
  - **Jambonz**: When the call is first marked as started in the progress handler
  - **Ultravox WebRTC**: When the call record is created (at listen time for non-telephony calls)

- **End events**: Triggered when a call is marked as ended. For different agent types:
  - **Livekit agent-db**: When `POST /api/agent-db/call/{callId}/end` is called
  - **Jambonz**: After the session handler completes and the call is ended
  - **Ultravox WebRTC**: When the Ultravox webhook indicates the call has ended

### Error Handling

Your callback endpoint should:

- Return a 2xx status code to indicate successful processing
- Handle timeouts gracefully (callbacks have a 5-second timeout)
- Be idempotent (same callback may be sent multiple times in edge cases)
- Log errors for debugging but avoid throwing exceptions that could affect call processing

### Best Practices

1. **Use HTTPS**: Always use HTTPS URLs for call hooks to protect sensitive data
2. **Verify Hashes**: Always verify the hash when `hashKey` is configured to ensure request authenticity
3. **Handle Missing Fields**: Some fields (like `agentId`, `listenerId`, `reason`, `durationSeconds`) may be `null` or omitted
4. **Idempotent Processing**: Design your webhook handler to be idempotent in case the same callback is received multiple times
5. **Async Processing**: Process callbacks asynchronously if you need to perform long-running operations
6. **Error Logging**: Log errors but return success status codes to avoid retry loops

## Example Webhook Handler

Here's a complete example of a webhook handler using Express.js:

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

function verifyHash(payload, hashKey) {
  if (!hashKey || !payload.hash) return false;
  
  const canonical = `${hashKey}|${payload.callId}|${payload.listenerId || ''}|${payload.agentId || ''}`;
  const hmac = crypto.createHmac('sha256', hashKey);
  hmac.update(canonical);
  const expectedHash = hmac.digest('hex');
  
  return payload.hash === expectedHash;
}

app.post('/call-hook', async (req, res) => {
  const payload = req.body;
  const hashKey = process.env.CALL_HOOK_SECRET;
  
  // Verify hash if configured
  if (hashKey && !verifyHash(payload, hashKey)) {
    console.error('Invalid hash for call hook', { callId: payload.callId });
    return res.status(401).send('Invalid hash');
  }
  
  try {
    // Process based on event type
    if (payload.event === 'start') {
      console.log(`Call started: ${payload.callId}`, {
        callerId: payload.callerId,
        calledId: payload.calledId,
        agentId: payload.agentId,
        listenerId: payload.listenerId
      });
      
      // Store call start event in your database
      await storeCallStart(payload);
      
    } else if (payload.event === 'end') {
      console.log(`Call ended: ${payload.callId}`, {
        duration: payload.durationSeconds,
        reason: payload.reason,
        hasTranscript: !!payload.transcript
      });
      
      // Store call end event and transcript
      await storeCallEnd(payload);
      
      // Process transcript if available
      if (payload.transcript) {
        await processTranscript(payload.callId, payload.transcript);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing call hook', error);
    // Still return 200 to avoid retries
    res.status(200).send('OK');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Call hook server listening on port ${PORT}`);
});
```

## Troubleshooting

### Callbacks Not Received

1. **Check Configuration**: Verify that `callHook.url` is correctly configured and accessible
2. **Check Events**: Ensure the event type (`start` or `end`) is included in the `events` array
3. **Check Network**: Verify that your callback URL is accessible from the LLM agent server
4. **Check Logs**: Review server logs for callback errors or warnings

### Hash Verification Failing

1. **Check Hash Key**: Ensure the `hashKey` matches exactly between configuration and verification
2. **Check Field Order**: The hash is computed over `hashKey|callId|listenerId|agentId` in that exact order
3. **Check Empty Fields**: Empty `listenerId` or `agentId` should be treated as empty strings, not `null`

### Transcript Missing

1. **Check Configuration**: Ensure `includeTranscript` is set to `true`
2. **Check Event Type**: Transcripts are only included in `end` events
3. **Check Availability**: Transcripts may not be available for all call types or if the call ended before any conversation occurred

## Related Documentation

- [API Documentation](../API.md) - Full API reference including call hook configuration
- [Phone Endpoints API](./phone-endpoints-api.md) - Configuring phone endpoints for agents

