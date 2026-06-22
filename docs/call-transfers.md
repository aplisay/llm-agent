# Call Transfers in LLM Agents

This document describes how to implement call transfers in LLM agents, covering both blind transfers and consultative (warm) transfers. It explains the underlying mechanisms, when different transfer methods are used, and provides detailed examples for building agents that use these features.

## Overview

The LLM agent platform supports two types of call transfers:

1. **Blind Transfer**: Immediately transfers the call to the specified number without any consultation
2. **Consultative Transfer**: The agent first speaks with the transfer target to explain the caller's needs, then connects them if the target accepts

Both transfer types are implemented using the builtin `transfer` platform function, which is only available for telephone agents when outbound calling or SIP redirects are enabled for the provider trunk.

The `transfer.number` parameter must be `static` or `metadata` (never `generated`). Because `metadata` supports arbitrary-depth dot paths, you can also source `transfer.number` from values written into `metadata.toolsCalls` by earlier tool calls (server-side tool result chaining) on **LiveKit agents only**. See [`tool-call-chaining-metadata-priming.md`](./tool-call-chaining-metadata-priming.md) for a DB-backed receptionist example.

### Transferring to another AI agent

This document covers transferring calls to **phone numbers and SIP endpoints**. To hand a live call from one AI agent to *another AI agent* — same call, no new call leg — use the builtin `transfer_agent` platform function instead. It follows the same anti-fraud parameter rules as `transfer` (the target is `static`/`metadata`, never LLM-`generated`), supports carrying the conversation history and an LLM-written handover summary across, and automatically chooses between an in-place prompt/tool swap (same model, same call record) and a full agent-stack restart with a child call record (model change). See [`multi-agent-api.md`](./multi-agent-api.md) for the full guide; the two mechanisms compose — e.g. a front-desk agent can `transfer_agent` between specialists and any of them can `transfer` out to a human.

## Transfer Mechanisms

### Blind Transfers

Blind transfers may be implemented using two different mechanisms, depending on the capabilities of the original caller's connection.
The decision on which to use is transparent to the LLM tools call and the most appropriate method will be chosen by the implementation based on the call's origin (see [Transfer mode selection](#transfer-mode-selection) below). You can override the automatic selection per transfer with the `forceBridged` or `forceRefer` parameters, or change the default for an endpoint with the `forceReferTransfer` (trunk) / `bridged_transfer` (registration) options.

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

#### 3. Worker-side media relay (WebRTC origin)

Bridging (Case 1) and REFER (Case 2) both rely on the original caller being a **SIP** participant: bridging loops the two legs together *inside a SIP gateway*, and REFER hands a SIP dialog back upstream. A **WebRTC / browser** caller has neither — their media terminates in the worker's `SmallWebRTCTransport`, not in any SIP gateway. So a transfer from a browser caller to a telephony endpoint is always bridged, but the bridge is built in the **one place both media endpoints meet — the worker itself**:

1. The worker resolves the egress trunk + caller ID (see below), then **originates a new outbound telephony leg** to the target through the configured SIP gateway.
2. A pair of lightweight processors (a *tap* after the transport input, an *injector* before the transport output — see `agents/pipecat/pipecat_aplisay/media_relay.py`) are spliced into both legs' Pipecat pipelines. Engaging them relays raw PCM audio between the browser peer and the telephony leg in both directions; the agent goes silent and idle, and the two parties hear only each other.
3. **Nothing is torn down** to install the relay — both pipelines keep running — so the WebRTC peer connection (which would otherwise disconnect on pipeline end) stays up across the cutover.

Because the relay carries decoded PCM, the browser's Opus/48 kHz audio and the telephony leg's G.711/8 kHz audio are reconciled by Pipecat's normal resampling at each transport sink — there is no same-codec constraint (unlike the in-gateway bridge, which is G.711-only).

`forceRefer` is meaningless for a WebRTC origin (there is no SIP dialog to REFER) and is ignored. Consultative transfers from a WebRTC caller use the **same** relay for their finalise step: the consultation runs a TransferAgent on the outbound leg as usual, and on `accept_transfer` the worker engages the browser↔target relay instead of an in-gateway bridge.

**Caller ID behaviour (WebRTC origin):** a browser call has no inbound trunk, so the outbound leg dials out on the egress trunk belonging to the supplied `callerId` number. The `callerId` is therefore **required** for transfers from a browser session, and must be a number known to the platform with outbound calling enabled (its trunk becomes the egress path). This mirrors LiveKit's caller-ID resolution.

### Transfer mode selection

Whether a transfer is completed by **bridging** (media stays on the platform) or by **SIP REFER** (the call is handed back to the upstream and leaves the platform) is decided by the call's origin, with optional overrides. The same logic governs the final hop of a [consultative transfer](#consultative-transfers).

**Origin defaults:**

| Origin | Default mechanism | Rationale |
| --- | --- | --- |
| Registration endpoint | SIP REFER | The registered endpoint / its B2BUA is normally REFER-capable, and REFER frees the platform from carrying the call. |
| SIP trunk | Bridging | Most carrier trunks don't handle REFER (let alone REFER-with-Replaces) reliably, so bridging is the safe default. |
| WebRTC / browser | Bridging | No SIP signalling path to REFER over. |

**Overrides**, in order of precedence (highest first):

1. **Per-transfer parameter** on the `transfer` tool call:
   - `forceRefer: true` — force the transfer to complete via SIP REFER.
   - `forceBridged: true` — force the transfer to stay bridged on the platform.
   - `forceRefer` wins if both are somehow set.
2. **Endpoint / trunk option** (configured against the phone endpoint, not per call):
   - `forceReferTransfer: true` in a **trunk's** options — make this trunk default to REFER instead of bridging.
   - `bridged_transfer: true` in a **registration endpoint's** options — make this endpoint default to bridging instead of REFER. (Registration options are snake_case to match the other keys on that structure; in code the value surfaces as the camelCase `forceBridged`. See [phone-endpoints-api.md](./phone-endpoints-api.md).)
3. **Origin default** from the table above.

### Consultative Transfers

Consultative transfers run a consultation phase first and then finalise either by **bridging** the two legs together or, where the origin supports it, by an **attended SIP REFER (REFER-with-Replaces, RFC 3891)** that hands both legs off to the upstream and drops the platform out of the media path entirely. The choice follows exactly the same [Transfer mode selection](#transfer-mode-selection) rules as blind transfers: bridging is the default on SIP trunks, attended REFER is the default for registration endpoints, and `forceRefer` / `forceBridged` (per transfer) or `forceReferTransfer` (trunk) / `bridged_transfer` (registration) override it.

When the attended-REFER path is taken, the platform sends the original caller a `REFER` whose `Refer-To` embeds `?Replaces=<consult-dialog>` identifying the consultation leg; the caller re-INVITEs the transfer target directly, replacing the consultation dialog, and both bot legs drop out. If a gateway cannot drive an attended REFER, it transparently falls back to bridging so the transfer still completes.

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
   - The two parties are connected either by **bridging** (a new bridged call record is created and the platform keeps carrying the call) or, on origins that support it, by an **attended SIP REFER with Replaces** (the original call record is ended and the call leaves the platform). Which one is used follows the [Transfer mode selection](#transfer-mode-selection) rules.

**Key Features:**
- The `transfer` function returns immediately after the consultation call is placed
- The transfer continues asynchronously in the background
- The main agent can check transfer status using the `transfer_status` function
- A separate call record is created for the consultation leg, including its transcript
- If the transfer is accepted, the two parties are connected via either a bridge or an attended SIP REFER, depending on the call's origin and any `forceRefer` / `forceBridged` overrides.

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
      "consultFeedback": {
        "in": "query",
        "type": "boolean",
        "source": "static",
        "required": false,
        "description": "When true, enables returning detailed rejection feedback from consultative transfers in the transfer_status description. When omitted or false, only a generic 'Transfer failed' message is returned. Defaults to false."
      },
      "forceBridged": {
        "in": "query",
        "type": "boolean",
        "source": "static",
        "required": false,
        "description": "When true, forces the transfer to stay bridged on the platform even when the origin would default to SIP REFER. Defaults to false. Applies to both blind and consultative transfers (overriding the origin default for the final hop). See 'Transfer mode selection'."
      },
      "forceRefer": {
        "in": "query",
        "type": "boolean",
        "source": "static",
        "required": false,
        "description": "When true, forces the transfer to complete via SIP REFER (with ?Replaces for the consultative finalize) even when the origin would default to bridging. Defaults to false. Takes precedence over forceBridged when both are set. See 'Transfer mode selection'."
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
- The system automatically chooses between SIP REFER and bridging based on the call's origin (see [Transfer mode selection](#transfer-mode-selection))
- Optional `callerId` can be specified to override the caller ID presented to the transfer target
- Optional `forceBridged` can be set to `true` to force bridging, or `forceRefer` to force SIP REFER, overriding the origin default

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
- Optional `consultFeedback` can enable returning detailed rejection feedback from the consultation when the transfer is rejected

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

### Consultative Transfer Feedback

When performing consultative transfers, the TransferAgent may provide detailed rejection reasons explaining why the transfer target declined the call. By default, these detailed reasons are **not** shared with the original agent to keep the consultation confidential.

Use the `consultFeedback` parameter to enable returning detailed rejection feedback:

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
          "consultFeedback": {
            "type": "boolean",
            "source": "static",
            "from": true,
            "description": "Enable returning detailed rejection feedback in transfer_status"
          }
        }
      }
    }
  ]
}
```

**Behavior:**
- When `consultFeedback: true`:
  - If the transfer is rejected, `transfer_status` returns `{ state: "rejected", description: "<detailed rejection feedback>" }` including the detailed rejection summary from the consultation
  - The original agent can see and use this feedback to explain the outcome to the caller
- When `consultFeedback: false` or omitted:
  - If the transfer is rejected, `transfer_status` returns `{ state: "rejected", description: "Transfer failed" }` without any detailed rejection reasons
  - Detailed rejection information from the TransferAgent is kept confidential and not shared with the original agent

**Use cases:**
- Opting in to share detailed consultative feedback with the original agent when appropriate
- Keeping the default behavior privacy-preserving unless feedback is explicitly enabled

### Confidence Tone

While a transfer is in flight the caller can otherwise be left listening to dead air: a blind transfer may spend several seconds dialling the target before the SIP REFER completes or the bridged media comes up, and a consultative transfer parks the caller while the TransferAgent speaks with the target on a separate leg. Setting `options.transferTone` plays a periodic comfort beep to the caller during these windows so they know the call is still alive.

```json
{
  "name": "My Agent",
  "options": {
    "transferTone": true
  }
}
```

Or, with explicit tuning (all fields optional — the values below are the defaults):

```json
{
  "options": {
    "transferTone": {
      "enabled": true,
      "frequency": "medium",
      "length": "medium",
      "volume": "medium",
      "gapMs": 2750,
      "graceMs": 1200
    }
  }
}
```

| Field | Default | Values | Description |
|-------|---------|--------|-------------|
| `enabled` | `true` | boolean | Set `false` to disable without removing the object |
| `frequency` | `"medium"` | `low` \| `medium` \| `high` | Tone pitch (`low` ≈ 350 Hz, `medium` ≈ 425 Hz, `high` ≈ 550 Hz) |
| `length` | `"medium"` | `short` \| `medium` \| `long` | Burst length (`short` ≈ 150 ms, `medium` ≈ 250 ms, `long` ≈ 400 ms) |
| `volume` | `"medium"` | `low` \| `medium` \| `high` | Tone loudness (`low` ≈ 0.08, `medium` ≈ 0.15, `high` ≈ 0.30 linear amplitude) |
| `gapMs` | `2750` | 0–60000 | Silence between bursts in milliseconds |
| `graceMs` | `1200` | 0–30000 | Quiet time required after either party last spoke before the tone starts |

The tone *shape* (`frequency`, `length`, and `volume`) is chosen from a small fixed set rather than free-form Hz/ms/amplitude, so the platform can serve pre-generated tones for efficiency; only the silence timings (`gapMs`, `graceMs`) are continuous.

**Behaviour:**

- **Blind transfers** — the tone plays from the moment the transfer starts dialling until it succeeds (the SIP REFER completes, or the bridged media is established) or fails. It then stops permanently for that transfer.
- **Consultative transfers** — the tone plays for the whole consultation (dialling and while the TransferAgent speaks with the target), but only in the gaps where **neither the caller nor the agent is audibly speaking**: the original agent can still converse with the caller mid-consultation, and the tone yields to that conversation, resuming after `graceMs` of silence. It stops when the consultation concludes (accepted, rejected, or failed).
- **Agent-to-agent handover** — when a full-stack agent transfer (`transfer_agent` with a model change, or an Ultravox realtime agent) tears down the outgoing agent's session and spins up the incoming agent's model stack, the same comfort tone covers that dead-air gap. It plays in the silence once the new pipeline is live and stops the instant the incoming agent first speaks (with a safety backstop if it never does). As with the consultative case, the tone yields to any speech and resumes after `graceMs` of silence.

The tone is generated by the worker and is supported on both the LiveKit and Pipecat stacks for all transfer mechanisms (bridging, SIP REFER, the WebRTC worker-side media relay, and full-stack agent-to-agent handover). When `transferTone` is unset, behaviour is unchanged and no tone path is constructed.

### Forcing the transfer mechanism

By default, the system selects the transfer mechanism (bridging or SIP REFER) from the call's origin — see [Transfer mode selection](#transfer-mode-selection). You can override this per transfer with `forceBridged: true` (force bridging) or `forceRefer: true` (force SIP REFER, including the attended REFER-with-Replaces finalize for consultative transfers). `forceRefer` takes precedence if both are set. To change the default for a whole endpoint instead of per call, use the `forceReferTransfer` (trunk) or `bridged_transfer` (registration) endpoint options documented in [phone-endpoints-api.md](./phone-endpoints-api.md).

The example below forces bridging; set `forceRefer` instead to force SIP REFER.

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

**Note:** `forceBridged` and `forceRefer` apply to both blind and consultative transfers — for a consultative transfer they select how the *final hop* is completed (media bridge vs attended SIP REFER with Replaces) once the transfer target accepts. If a gateway can't honour an attended REFER it falls back to bridging automatically.

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
8. If accepted: Status set and transfer target moved to main room
9. If rejected: Status set and consultation room cleaned up
10. Consultation call record created with transcript

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
8. **Consultative feedback control**: The `consultFeedback` parameter controls whether detailed rejection reasons from consultative transfers are shared back to the main agent via the `transfer_status` description. By default (when omitted or false), only a generic "Transfer failed" message is returned and detailed rejection information remains confidential. Setting `consultFeedback` to true opts in to sharing the detailed rejection feedback.

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

