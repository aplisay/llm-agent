# Ultravox Transcription Options

This document describes how to configure vendor-specific transcription options for Ultravox agents using the `vendorSpecific` option.

## Overview

Ultravox supports experimental transcription providers that can improve transcription quality. These options are configured using the `vendorSpecific` field in agent options, which allows passing vendor-specific settings directly to the Ultravox API.

## Configuration

To configure Ultravox transcription options, add a `vendorSpecific` object to your agent's `options` when creating or updating an agent:

```json
{
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "experimentalSettings": {
          "transcriptionProvider": "<provider-name>"
        }
      }
    }
  }
}
```

## Available Transcription Providers

### Option 1: Deepgram Nova 3

Use Deepgram's new Nova 3 model for improved transcription quality while keeping your existing model (e.g., Llama 3.3).

**Configuration:**
- Keep your existing model string (e.g., `livekit:ultravox/ultravox-v0.7` or `fixie-ai/ultravox-70B`)
- Add `experimentalSettings` with `transcriptionProvider: "deepgram-nova-3"`

**Example Agent Creation:**

```json
POST /api/agents
{
  "modelName": "livekit:ultravox/ultravox-v0.7",
  "prompt": "You are a helpful assistant.",
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "experimentalSettings": {
          "transcriptionProvider": "deepgram-nova-3"
        }
      }
    }
  }
}
```

### Option 2: GLM 4.6 with Ultravox Transcription

Use GLM 4.6 model with Ultravox's native transcription provider.

**Configuration:**

- Set model string to `"livekit:ultravox/ultravox-0.7"`
- Add `experimentalSettings` with `transcriptionProvider: "ultravox"`

**Example Agent Creation:**

```json
POST /api/agents
{
  "modelName": "livekit:ultravox/ultravox-0.7",
  "prompt": "You are a helpful assistant.",
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "experimentalSettings": {
          "transcriptionProvider": "ultravox"
        }
      }
    }
  }
}
```

### Agent Options Schema

The `options.vendorSpecific` field is an opaque object that accepts vendor-specific configuration. For Ultravox, the structure is:

```json
{
  "vendorSpecific": {
    "ultravox": {
      "experimentalSettings": {
        "transcriptionProvider": "deepgram-nova-3" | "ultravox"
      }
    }
  }
}
```

See the [Agent Options Schema](https://llm.aplisay.com/api#/components/schemas/AgentOptions) in the API documentation for more details.

