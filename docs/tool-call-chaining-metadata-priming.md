# Tool Call Chaining via Metadata Priming

When an LLM calls multiple tools in a single conversation, you may need tool results from the earlier call to be available to the later call.
We often let the LLM strategise and actually execute sequential tools calls with result chaining, but there can be times when we need to be *certain* algorithmically that the input to the second call is exactly the output from a previous call without the nondeterminism that can be introduced by round-tripping the data through the LLM.

An example of this could be where there is a legal or critical business requirement to provide traceability of the data.
This platform supports that pattern by:

1. Executing tool calls sequentially (in the order returned by the LLM).
2. Writing each tool call’s inputs + outputs into call metadata under `metadata.toolsCalls`.
3. Allowing later tools (including platform builtins like `transfer()` to read those values using `source: "metadata"` and dot-notation paths.

## What gets written into `metadata.toolsCalls`

After executing a tool named `someTool`, in a livekit based agent, the server stores:

- `metadata.toolsCalls.someTool.parameter` = the resolved input object used for the tool call
- `metadata.toolsCalls.someTool.result` = the parsed tool result (if it is valid JSON), otherwise the raw result

You can reference either of these with `source: "metadata"` using arbitrary-depth dot paths (e.g. `toolsCalls.someTool.result.transferNumber`).

## Security model for “hardwiring” sensitive values

The key safety property is this: if a tool parameter is defined with `source: "metadata"`, the LLM cannot “invent” or “prompt-inject” the value because that parameter is resolved server-side from metadata.

In particular, the built-in `transfer` function’s `number` parameter is only allowed as `static` or `metadata` (never `generated`). That means you can:

- Load the correct transfer directory number from a database using a tool call.
- Use the result as server-side metadata input to `transfer`.
- Prevent the LLM from ever supplying (or overriding) the transfer destination.

## LiveKit-only enforcement

For security reasons, references to `metadata.toolsCalls...` from tool inputs (`source: "metadata"`, with `from: "toolsCalls...."`) are only permitted on **LiveKit agents**.

If you try to create a non-LiveKit agent whose function schemas reference `toolsCalls.*` via `source: "metadata"`, the API will reject the `/agents` POST request.

## Hypothetical example: receptionist transfer number (DB-backed, LLM-safe)

Goal:

- An AI receptionist agent decides that the caller should be transferred to a specific internal department.
- The actual transfer directory number must come from your database/CRM.
- The LLM must not supply or hallucinate the number.

### Step 1: Fetch the directory number (tool call)

Define a tool (implemented as `rest` here) that looks up the directory number:

```json
{
  "name": "lookup_receptionist_transfer_number",
  "description": "DB lookup for the receptionist transfer directory number",
  "implementation": "rest",
  "key": "",
  "method": "get",
  "url": "https://crm.example.com/reception/transfer-number?department={department}",
  "input_schema": {
    "properties": {
      "department": { 
        "description": "The department name the caller asked for",
        "type": "string", 
        "in": "query"
        "source": "generated", 
        "required": true 
        }
    }
  }
}
```

Assume the REST API returns JSON like:

```json
{ "transferNumber": "+44201234567" }
```

After the tool executes, the server primes metadata like:

- `metadata.toolsCalls.lookup_receptionist_transfer_number.result.transferNumber`

### Step 2: Hardwire `transfer.number` from the primed metadata

Now define a builtin transfer tool that reads the `number` from metadata (not from LLM-generated inputs):

```json
{
  "name": "transfer_to_receptionist",
  "description": "Transfer using a DB-backed directory number (LLM-safe)",
  "implementation": "builtin",
  "platform": "transfer",
  "input_schema": {
    "properties": {
      "number": {
        "type": "string",
        "source": "metadata",
        "from": "toolsCalls.lookup_receptionist_transfer_number.result.transferNumber",
        "required": true
      },
      "operation": {
        "type": "string",
        "source": "static",
        "from": "blind"
      }
    }
  }
}
```

When the LLM calls `transfer_to_receptionist`, it does *not* need to know or construct the phone number.

Even if a prompt-injection tries to influence the call (or the model hallucinate a number), the `transfer.number` value is resolved server-side from `metadata.toolsCalls...` and therefore cannot be changed by the LLM.

## Required pattern in your tool call design

To chain correctly, you must ensure the DB lookup tool executes before the transfer tool in the same LLM response (or across the same session, since metadata is mutated in memory while the conversation continues).

Concretely:

1. LLM calls `lookup_receptionist_transfer_number` (with department).
2. Server stores its result in `metadata.toolsCalls.lookup_receptionist_transfer_number.result`.
3. LLM calls `transfer_to_receptionist`, whose `number` parameter is resolved from that metadata path.

## Important limitation

This pattern depends on dynamic metadata updates during the lifecycle of an agent. These are only implemented on agents where the tools call runtime is implemented within the Aplisay infrastructure (currently Jambonz and Livekit agents). This mechanism isn't available in other environments (e.g. native Ultravox WebRTC agents). If you are using this mechanism then you must must use the Aplisay `livekit:` variant of the Ultravox model string.
