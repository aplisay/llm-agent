# Call Transfers in LLM Agents

This document describes how to implement call transfers in LLM agents, covering both blind transfers and consultative (warm) transfers. It explains the underlying mechanisms, when different transfer methods are used, and provides detailed examples for building agents that use these features.

## Overview

The LLM agent platform supports two types of call transfers:

1. **Blind Transfer**: Immediately transfers the call to the specified number without any consultation
2. **Consultative Transfer**: The agent first speaks with the transfer target to explain the caller's needs, then connects them if the target accepts

Both transfer types are implemented using the builtin `transfer` platform function, which is only available for telephone agents when outbound calling or SIP redirects are enabled for the provider trunk.

## Transfer Mechanisms

### Blind Transfers

Blind transfers may be implemented using two different mechanisms, depending on the capabilities of the original caller's connection.
The decision on which to use is transparent to the LLM tools call and the most appropriate method will be chosen by the implementation. However, you can force bridging by setting the `forceBridged` parameter to `true`, which will override the automatic selection and always use bridging even when SIP REFER is available.

#### 1. Bridging (Case 1)

**When used:**
- The original caller is a SIP participant but `canRefer` is not available or disabled
- The `forceBridged` parameter is set to `true` (overrides REFER capability)

**How it works:**
- The system creates a new SIP participant in the same LiveKit room
- The new participant is dialled to the transfer target number
- Both participants (original caller and transfer target) are in the same room
- The agent session is closed and a new bridged call record is created
- The room continues with both participants connected
- No AI is present, but per minute charges may apply because the Livekit room and the SIP trunk connections remain active and carrying the call until the callers disconnect.

**Advantages:**
- Works for all participant types
- No special SIP capabilities required
- Simple and reliable
- Platform continues to carry the call even after the AI session has ended.

**Caller ID behaviour:** When we create the new bridged leg, the Caller ID presented to the outbound trunk is the agent's identity. To preserve context, we also set the `X-Aplisay-Origin-Caller-Id` SIP header with the original Caller ID when it is available. Be aware that if the call reached the agent via a forward or divert, the upstream system may have regenerated the Caller ID, so the true original CLI may already be lost by the time we see it. If Caller ID provenance matters for your workflow, consult the telco architect who designed the redirect path to understand what information is preserved and what is rewritten in transit.

#### 2. SIP REFER (Case 2)

**When used:**
- The original caller is a SIP participant
- The SIP trunk or registration endpoint has `canRefer` capability enabled
- For registration-originated calls, `canRefer` defaults to `true`
- For trunk-based calls, `canRefer` must be explicitly enabled in the trunk configuration (no trunks are currently known to support this)

**How it works:**
- The system sends a SIP REFER request to the original caller's endpoint
- The caller's endpoint initiates a new call to the transfer target
- The original call leg is replaced by the new call leg
- The Agent simply sees the call drop as if the original caller had hungup.
- All billing from the AI platform stops as the call is now gone off the platform.

**Advantages:**
- More efficient - the transfer happens at the SIP level
- The caller's endpoint handles the new call setup
- Better for registration-originated calls where the endpoint can handle REFER

**Caller ID behaviour:** When SIP REFER (deflect) is used, the call is effectively handed back to the upstream system, which then redirects the caller to the target. The upstream PBX or carrier is responsible for generating the Caller ID that the transfer target sees. Because the call never re-enters our media path, we cannot attach custom headers such as `X-Aplisay-Origin-Caller-Id` and we have no control over which Caller ID the upstream system presents. If you need guarantees about Caller ID propagation in REFER flows, speak with the telco architect who designed the redirect path to understand the limitations imposed by that infrastructure.

### Consultative Transfers

Consultative transfers always use the bridging mechanism, regardless of the original caller's connection type. SIP REFER for consultative transfers is currently not possible due to limitations in SIP signalling in the architecture we use, although this is under investigation so may change in future.

**How it works:**

1. **Consultation Phase:**
   - A separate consultation room is created
   - The transfer target is dialed into the consultation room
   - A TransferAgent (separate LLM agent instance) joins the consultation room
   - The TransferAgent explains the caller's needs to the transfer target
   - The TransferAgent waits for the target to accept or reject the transfer

2. **Transfer Decision:**
   - If accepted: The transfer target is moved from the consultation room to the main room
   - If rejected: The consultation room is cleaned up

3. **Finalisation:**
   - The consultation room is deleted
   - The TransferAgent session is closed
   - A consultation call record is created and ended with a transcript
   - The original call record is ended and a new bridged call record is created

**Key Features:**
- The `transfer` function returns immediately after the consultation call is placed
- The transfer continues asynchronously in the background
- The main agent can check transfer status using the `transfer_status` function
- A separate call record is created for the consultation leg, including its transcript
- If the transfer is accepted then a bridged transfer between the two parties takes place.

## Building Agents with Transfers

### Basic Transfer Function Definition

All transfer functions use the `transfer` platform function with the following structure:

```json
{
  "name": "transfer",
  "implementation": "builtin",
  "platform": "transfer",
  "description": "Transfer the call to another number",
  "input_schema": {
    "type": "object",
    "properties": {
      "number": {
        "in": "query",
        "from": "+44123456789",
        "type": "string",
        "source": "static",
        "required": false,
        "description": "The phone number or endpoint ID to transfer to"
      },
      "operation": {
        "in": "query",
        "from": "blind",
        "type": "string",
        "source": "static",
        "required": false,
        "description": "The transfer operation type: 'blind' or 'consultative'"
      },
      "callerId": {
        "in": "query",
        "type": "string",
        "source": "static",
        "required": false,
        "description": "Optional caller ID to use for the transfer. Must be a phone number owned by your organisation with outbound calling enabled. If not specified, uses the original called number."
      },
      "transferPrompt": {
        "in": "query",
        "type": "string",
        "source": "static",
        "required": false,
        "description": "Custom prompt for the TransferAgent in consultative transfers. Only applies when operation is 'consultative'. Can use ${parentTranscript} placeholder."
      },
      "confidentialConsult": {
        "in": "query",
        "type": "boolean",
        "source": "static",
        "required": false,
        "description": "When true, suppresses detailed rejection reasons from consultative transfers. Only generic 'Transfer failed' message is returned to the original agent. Defaults to false."
      },
      "forceBridged": {
        "in": "query",
        "type": "boolean",
        "source": "static",
        "required": false,
        "description": "When true, forces a bridged transfer even when the trunk or registration endpoint supports SIP REFER. Defaults to false. Only applies to blind transfers."
      }
    }
  },
}
```

### Example 1: Blind Transfer Agent

Here's a complete example of an agent that performs blind transfers:

```javascript
export default {
  "name": "Blind Transfer Agent",
  "description": "A simple agent that transfers a call to a human",
  "modelName": "livekit:ultravox/ultravox-70b",
  "prompt": "As soon as you get a call, say \"hello\" then call the transfer function.",
  "options": {
    "temperature": 0.2
  },
  "functions": [
    {
      "name": "transfer",
      "method": "get",
      "implementation": "builtin"
      "platform": "transfer",
      "description": "Transfer to a human",
      "input_schema": {
        "type": "object",
        "properties": {
          "number": {
            "in": "query",
            "from": "03300889471",
            "type": "string",
            "source": "static",
          }
        }
      },
    }
  ]
};
```

**Key points:**
- The `operation` parameter is omitted, defaulting to `"blind"`
- The function returns `OK` when the transfer completes
- The agent session ends immediately after the transfer
- The system automatically chooses between SIP REFER and bridging based on capabilities
- Optional `callerId` can be specified to override the caller ID presented to the transfer target
- Optional `forceBridged` can be set to `true` to force bridging even when REFER is available

### Example 2: Consultative Transfer Agent

Here's a complete example of an agent that performs consultative transfers:

```javascript
export default {
  "name": "Consultative Transfer Agent",
  "description": "An agent that determines the nature of the enquiry and performs a consultative transfer to an appropriate human",
  "modelName": "livekit:ultravox/ultravox-70b",
  "prompt": "You are a helpful assistant. When you receive a call, greet the caller and determine the nature of their enquiry. Once you understand what they need, call the transfer function to initiate a consultative transfer. After calling transfer, periodically call transfer_status to check the progress of the transfer and keep the caller informed about what's happening. Let them know when the transfer target is being called, when you're speaking with them, and when the transfer is completed or if there are any issues.",
  "options": {
    "temperature": 0.2
  },
  "functions": [
    {
      "name": "transfer",
      "method": "get",
      "platform": "transfer",
      "description": "Perform a consultative transfer to a human. This will connect you to the transfer target first so you can explain the caller's needs, then connect the caller if the transfer target accepts. The operation parameter is set to 'consultative' to enable this consultative transfer mode.",
      "input_schema": {
        "type": "object",
        "properties": {
          "number": {
            "in": "query",
            "from": "03300889471",
            "type": "string",
            "source": "static",
            "required": false,
            "description": "The phone number or endpoint ID to transfer to"
          },
          "operation": {
            "in": "query",
            "from": "consultative",
            "type": "string",
            "source": "static",
            "required": false,
            "description": "The transfer operation type - must be 'consultative' for this function"
          }
        }
      },
      "implementation": "builtin"
    },
    {
      "name": "transfer_status",
      "method": "get",
      "platform": "transfer_status",
      "description": "Check the current status of any in-progress transfer. Returns the state (none, dialling, talking, rejected, or failed) and a description. Use this to monitor the progress of a consultative transfer and keep the caller informed.",
      "input_schema": {
        "type": "object",
        "properties": {}
      },
      "implementation": "builtin"
    }
  ]
};
```

**Key points:**
- The `operation` parameter is set to `"consultative"`
- The `transfer` function returns immediately with status `OK` and a message indicating the consultation has started
- The agent must call `transfer_status` periodically to check progress
- The agent should keep the caller informed about the transfer status
- Optional `transferPrompt` can customize how the TransferAgent introduces the call
- Optional `confidentialConsult` can suppress detailed rejection reasons for privacy

## Transfer Status Monitoring

For consultative transfers, the `transfer_status` function is essential for monitoring the transfer progress. This function is always available to telephone agents and takes no parameters.

### Transfer Status States

The `transfer_status` function returns an object with the following states:

- **`none`**: No transfer in progress
- **`dialling`**: The transfer target is being called
- **`talking`**: The agent is speaking with the transfer target (consultative transfers only)
- **`rejected`**: The transfer target declined the transfer (consultative transfers only)
- **`failed`**: The transfer failed

### Response Format

```json
{
  "state": "talking",
  "description": "Speaking with transfer target..."
}
```

### Usage Pattern

For consultative transfers, the recommended pattern is:

1. Call `transfer` with `operation: "consultative"`
2. Receive immediate response: `{ status: "OK", reason: "Consultation started. Use transfer_status to check progress." }`
3. Periodically call `transfer_status` to check progress
4. Update the caller based on the status:
   - `dialling`: "I'm calling the transfer target now..."
   - `talking`: "I'm speaking with them now to explain your needs..."
   - `rejected`: "I'm sorry, but the transfer target is not available. Let me help you instead..."
   - `failed`: "I'm sorry, but the transfer failed. Let me help you instead..."
   - `none`: "The transfer has been completed. You should now be connected."

### Example Agent Prompt for Status Monitoring

```text
You are a helpful assistant. When you receive a call, greet the caller and determine the nature of their enquiry. Once you understand what they need, call the transfer function to initiate a consultative transfer.

After calling transfer, periodically call transfer_status to check the progress of the transfer and keep the caller informed about what's happening. Let them know:
- When the transfer target is being called ("I'm calling them now...")
- When you're speaking with them ("I'm explaining your situation to them now...")
- When the transfer is completed ("You should now be connected to them.")
- If there are any issues ("I'm sorry, but they're not available. Let me help you instead.")
```

## Transfer Parameters

### Caller ID Override

You can specify a custom caller ID to be presented to the transfer target using the `callerId` parameter:

```json
{
  "functions": [
    {
      "name": "transfer",
      "platform": "transfer",
      "input_schema": {
        "properties": {
          "number": {
            "type": "string",
            "source": "static",
            "from": "+44123456789"
          },
          "callerId": {
            "type": "string",
            "source": "static",
            "from": "+44123456780",
            "description": "The caller ID to present to the transfer target"
          }
        }
      }
    }
  ]
}
```

**Requirements:**
- The `callerId` must be a phone number owned by your organisation
- The number must have outbound calling enabled
- If the original call comes in on a telephony trunk, the caller ID number must use a matching egress trunk.
- For WebRTC calls, the caller ID trunk, it will be used for the outbound transfer

**Use cases:**
- Presenting a department-specific number instead of the agent number
- Using a dedicated transfer number for tracking purposes
- Maintaining consistent caller ID across multiple transfers

### Custom Transfer Prompts

For consultative transfers, you can customize the prompt used by the TransferAgent that speaks with the transfer target. This allows you to control how the call is introduced and what information is shared.

#### Agent-Level Configuration

You can set a default `transferPrompt` for all consultative transfers by an agent in the agent's options:

```json
{
  "name": "My Agent",
  "options": {
    "transferPrompt": "You are a transfer assistant. Here is the conversation history: ${parentTranscript}\n\nYou are now speaking with the person who will take over this call. Please:\n1. Briefly summarize why the caller needs help\n2. Ask if they can take the call\n3. If yes, call accept_transfer. If no, call reject_transfer.\n\nBe professional and concise."
  }
}
```

The `${parentTranscript}` placeholder will be automatically replaced with the conversation history between the caller and the original agent.

#### Per-Transfer Override

You can also override the prompt for a specific transfer by including `transferPrompt` as a parameter in the transfer function call. This takes precedence over the agent-level setting:

```json
{
  "functions": [
    {
      "name": "transfer_to_specialist",
      "description": "Transfer to a specialist with detailed context",
      "platform": "transfer",
      "input_schema": {
        "properties": {
          "number": {
            "type": "string",
            "source": "static",
            "from": "+44123456789"
          },
          "operation": {
            "type": "string",
            "source": "static",
            "from": "consultative"
          },
          "transferPrompt": {
            "type": "string",
            "source": "static",
            "from": "You are transferring a high-priority call. The caller has been waiting and needs immediate assistance. Conversation: ${parentTranscript}\n\nPlease accept this transfer urgently by calling accept_transfer."
          }
        }
      }
    }
  ]
}
```

**Priority order:**
1. `transferPrompt` parameter in the transfer function call (highest priority)
2. `options.transferPrompt` in agent configuration
3. Default system prompt (lowest priority)

**Note:** The `transferPrompt` parameter only applies to consultative transfers (`operation: "consultative"`). It is ignored for blind transfers. When used in function calls, `transferPrompt` can only be specified as `static` - it cannot be generated by the LLM or sourced from metadata.

### Confidential Consultative Transfers

When performing consultative transfers, the TransferAgent may provide detailed rejection reasons explaining why the transfer target declined the call. In some scenarios, you may want to keep this information confidential and not share it with the original agent.

Use the `confidentialConsult` parameter to suppress detailed rejection summaries:

```json
{
  "functions": [
    {
      "name": "transfer",
      "platform": "transfer",
      "input_schema": {
        "properties": {
          "number": {
            "type": "string",
            "source": "static",
            "from": "+44123456789"
          },
          "operation": {
            "type": "string",
            "source": "static",
            "from": "consultative"
          },
          "confidentialConsult": {
            "type": "boolean",
            "source": "static",
            "from": true,
            "description": "Suppress detailed rejection reasons for privacy"
          }
        }
      }
    }
  ]
}
```

**Behavior:**
- When `confidentialConsult: true`:
  - If the transfer is rejected, `transfer_status` returns `{ state: "rejected", description: "Transfer failed" }` instead of the detailed rejection summary
  - The original agent only sees a generic failure message
  - Detailed rejection information from the TransferAgent is not shared with the original agent
- When `confidentialConsult: false` or omitted:
  - Normal behavior - detailed rejection summaries are returned via `transfer_status`

**Use cases:**
- Protecting sensitive information shared during the consultation
- Maintaining privacy when transfer targets discuss confidential matters
- Complying with data protection requirements for sensitive consultations

### Force Bridged Transfers

By default, the system automatically selects the most appropriate transfer method (bridging or SIP REFER) based on the capabilities of the trunk or registration endpoint. However, you can force the system to use bridging even when SIP REFER is available by setting the `forceBridged` parameter to `true`.

```json
{
  "functions": [
    {
      "name": "transfer",
      "platform": "transfer",
      "input_schema": {
        "properties": {
          "number": {
            "type": "string",
            "source": "static",
            "from": "+44123456789"
          },
          "operation": {
            "type": "string",
            "source": "static",
            "from": "blind"
          },
          "forceBridged": {
            "type": "boolean",
            "source": "static",
            "from": true,
            "description": "Force bridged transfer even when REFER is available"
          }
        }
      }
    }
  ]
}
```

**When to use:**
- When you need to maintain control over the call path and ensure the platform continues to carry the call
- When you need to preserve custom SIP headers (like `X-Aplisay-Origin-Caller-Id`) that are not available with REFER
- When you need consistent billing behavior (bridged calls continue to incur platform charges)
- When the upstream system's REFER implementation has limitations or issues

**Note:** The `forceBridged` parameter only applies to blind transfers. Consultative transfers always use bridging regardless of this setting.

## Outbound Call Filter

The `outboundCallFilter` option provides security by restricting which phone numbers can be called via transfers or the originate endpoint. This prevents abuse, such as transferring calls to premium rate numbers.

### Configuration

Add the `outboundCallFilter` option to your agent definition:

```json
{
  "name": "My Agent",
  "options": {
    "outboundCallFilter": "^\\+44[1237]\\d{6,15}$"
  }
}
```

### How It Works

- The filter is a regular expression pattern
- The regexp is anchored with `^` and `$` to match the complete phone number
- Only outbound calls (via `transfer` or `originate`) where the destination number matches this pattern will be allowed
- If a transfer is attempted to a number that doesn't match the filter, the transfer will fail with an error

### Example Patterns

**UK mobile and geographic numbers:**
```json
"outboundCallFilter": "^\\+44[1237]\\d{6,15}$"
```

**US numbers only:**
```json
"outboundCallFilter": "^\\+1[2-9]\\d{9}$"
```

**Specific company numbers:**
```json
"outboundCallFilter": "^(\\+441234567890|\\+441234567891)$"
```

**UK numbers starting with specific area codes:**
```json
"outboundCallFilter": "^\\+44(20|131|161)\\d{8,9}$"
```

### Security Considerations

1. **Consider number injection attacks**: Telecommunications fraud is enormously lucrative, if you give potential attackers the ability to inject
numbers to be dialled then it is possible for them to easilly create 5 figure losses in a little as a day of calls
2. **Always use filters in production**: Without a filter, agents could potentially transfer calls to any number, including premium rate numbers
3. **Test your patterns**: Ensure your regexp correctly matches all valid numbers and rejects invalid ones
4. **Monitor transfer patterns**: Even with filters, monitor transfer destinations for unexpected patterns
5. **Combine with metadata**: For dynamic numbers, use metadata sources (like CRM systems) that also validate numbers before storing them
6. **Consider multi system attack vectors**: Look at the whole lifecycle of how a transfer number gets into the system you pull it from - if this can be injected or compromised then it creates an attack vector which can be monetised against your agent


## Transfer Flow Diagrams

### Blind Transfer Flow (Bridging)

```
[Original Caller] ──┐
                    ├──> [LiveKit Room] <── [Agent]
                    │
[Transfer Target] ──┘
     (after transfer)
```

1. Agent calls `transfer` function
2. System creates new SIP participant in room
3. New participant dials transfer target
4. Agent session closes
5. Both participants remain in room (bridged call)

### Blind Transfer Flow (SIP REFER)

```
[Original Caller] ──> [SIP REFER] ──> [Transfer Target]
     (original call ends)              (new call starts)
```

1. Agent calls `transfer` function
2. System sends SIP REFER to caller's endpoint
3. Caller's endpoint initiates new call to transfer target
4. Original call leg ends
5. Agent session closes
6. New bridged call record NOT created

### Consultative Transfer Flow

```
Phase 1: Consultation
[Original Caller] ──> [Main Room]
[Transfer Target] ──> [Consultation Room] <── [TransferAgent]

Phase 2: Decision
If accepted:
  [Transfer Target] ──> [Main Room] (moved from consultation room)
  [Original Caller] ──> [Main Room]
  [Consultation Room] ──> (deleted)

If rejected:
  [Original Caller] ──> [Main Room]
  [Consultation Room] ──> (deleted)
```

1. Agent calls `transfer` with `operation: "consultative"`
2. Consultation room created
3. Transfer target dialled into consultation room
4. TransferAgent joins consultation room
5. TransferAgent explains caller's needs
6. TransferAgent waits for accept/reject decision
7. Reject decision may include a summary of the reject target conversation to pass back to agent.
7. If accepted: Status set and transfer target moved to main room
8. If rejected: Status set and consultation room cleaned up
9. Consultation call record created with transcript

## Best Practices

1. **Always provide clear prompts**: Instruct your agent when and how to use transfers
2. **Monitor transfer status**: For consultative transfers, always check `transfer_status` and keep callers informed
3. **Use appropriate transfer types**:
   - Use blind transfers for simple redirects
   - Use consultative transfers when context needs to be explained and the transfer target needs to confirm acceptance of the call
4. **Set up outbound call filters**: Always configure `outboundCallFilter` in production which is defined tightly to only allow numbers you expect to be used
5. **Handle errors gracefully**: Instruct your agent to handle transfer failures and continue helping the caller
6. **Test thoroughly**: Test both transfer types with your specific trunk configuration

## Limitations and Notes

1. **Only one transfer at a time**: The system prevents concurrent transfers. If a transfer is already in progress, subsequent transfer requests will return `FAILED`
2. **Transfer numbers must be static or from metadata**: For security, transfer numbers cannot be generated by the LLM - they must come from static values or metadata
3. **Consultative transfers always use bridging**: SIP REFER for consultative transfers is currently disabled because, whilst theoretically possible, it isn't clear how to do this through current components (getting `Replaces:` through Livekit to the B2BUA)
4. **TransferAgent prompt is configurable**: The prompt used by the TransferAgent can be customized via `options.transferPrompt` at the agent level or via the `transferPrompt` parameter per transfer call. See the [Custom Transfer Prompts](#custom-transfer-prompts) section for details.
5. **Transfer status is only relevant for consultative transfers**: For blind transfers, the function returns immediately when the transfer completes
6. **Telephone agents only**: Transfer functionality is only available for telephone agents, not other agent types
7. **Caller ID validation**: When using the `callerId` parameter, the number must be owned by your organisation and have outbound calling enabled
8. **Confidential consult limitations**: The `confidentialConsult` parameter supresses any summary information about rejection reasons being passed from the transfer agent back to the main agent to prevent it giving the caller details derived from this conversation. This parameter only affects the rejection summary returned via `transfer_status`. It does not affect other failure messages or accepted transfers

## Troubleshooting

### Transfer fails immediately

- Check that outbound calling is enabled for your trunk
- Verify the destination number matches your `outboundCallFilter` pattern
- Ensure the number format is correct (E.164 format recommended for PSTN calls, but is specific to the trunk or registrar you are using for the outboud leg)

### Consultative transfer hangs

- Check that `transfer_status` is being called to keep the agent that initiated the transfer informed about the current status
- Ensure the main agent is prompted to continue responding to the caller until the consult ends
- Verify the transfer target is answering the call
- Check logs for TransferAgent errors in the consultation room

