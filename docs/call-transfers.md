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
The decision on which to use is transparent to the LLM tools call and the most appropriate method will be chosen by the implementation:

#### 1. Bridging (Case 1)

**When used:**
- The original caller is a SIP participant but `canRefer` is not available or disabled

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

### Consultative Transfers

Consultative transfers always use the bridging mechanism, regardless of the original caller's connection type. SIP REFER for consultative transfers is currently not possible due to limitations in SIP signalling, although this is under investigation.

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

```
You are a helpful assistant. When you receive a call, greet the caller and determine the nature of their enquiry. Once you understand what they need, call the transfer function to initiate a consultative transfer. 

After calling transfer, periodically call transfer_status to check the progress of the transfer and keep the caller informed about what's happening. Let them know:
- When the transfer target is being called ("I'm calling them now...")
- When you're speaking with them ("I'm explaining your situation to them now...")
- When the transfer is completed ("You should now be connected to them.")
- If there are any issues ("I'm sorry, but they're not available. Let me help you instead.")
```

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

1. **Always use filters in production**: Without a filter, agents could potentially transfer calls to any number, including premium rate numbers
2. **Test your patterns**: Ensure your regexp correctly matches all valid numbers and rejects invalid ones
3. **Monitor transfer patterns**: Even with filters, monitor transfer destinations for unexpected patterns
4. **Combine with metadata**: For dynamic numbers, use metadata sources (like CRM systems) that also validate numbers before storing them

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
6. New bridged call record created

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
3. Transfer target dialed into consultation room
4. TransferAgent joins consultation room
5. TransferAgent explains caller's needs
6. TransferAgent waits for accept/reject decision
7. If accepted: Transfer target moved to main room
8. If rejected: Consultation room cleaned up
9. Consultation call record created with transcript

## Best Practices

1. **Always provide clear prompts**: Instruct your agent when and how to use transfers
2. **Monitor transfer status**: For consultative transfers, always check `transfer_status` and keep callers informed
3. **Use appropriate transfer types**: 
   - Use blind transfers for simple redirects
   - Use consultative transfers when context needs to be explained
4. **Set up outbound call filters**: Always configure `outboundCallFilter` in production
5. **Handle errors gracefully**: Instruct your agent to handle transfer failures and continue helping the caller
6. **Test thoroughly**: Test both transfer types with your specific trunk configuration
7. **Document transfer numbers**: Keep track of which numbers are used for transfers and why

## Limitations and Notes

1. **Only one transfer at a time**: The system prevents concurrent transfers. If a transfer is already in progress, subsequent transfer requests will return `FAILED`
2. **Transfer numbers must be static or from metadata**: For security, transfer numbers cannot be generated by the LLM - they must come from static values or metadata
3. **Consultative transfers always use bridging**: SIP REFER for consultative transfers is currently disabled due to a LiveKit issue
4. **Transfer status is only relevant for consultative transfers**: For blind transfers, the function returns immediately when the transfer completes
5. **Telephone agents only**: Transfer functionality is only available for telephone agents, not other agent types

## Troubleshooting

### Transfer fails immediately

- Check that outbound calling is enabled for your trunk
- Verify the destination number matches your `outboundCallFilter` pattern
- Ensure the number format is correct (E.164 format recommended)

### Consultative transfer hangs

- Check that `transfer_status` is being called periodically
- Verify the transfer target is answering the call
- Check logs for TransferAgent errors in the consultation room

### Transfer target doesn't hear the caller

- For blind transfers: Verify both participants are in the room
- For consultative transfers: Check that the transfer was accepted and the target was moved to the main room

### SIP REFER not working

- Verify `canRefer` is enabled for your trunk (for trunk-based calls)
- Check that the original call is from a SIP participant (not WebRTC)
- For registration-originated calls, `canRefer` should work by default

