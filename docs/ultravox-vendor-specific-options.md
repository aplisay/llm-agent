# Ultravox vendor-specific agent options

This document describes how to configure **Ultravox-only** settings for agents that use the LiveKit Ultravox integration, via `options.vendorSpecific.ultravox`. Values are passed through to Ultravox when creating a call (see the [Ultravox Create Call API](https://docs.ultravox.ai/api-reference/calls/calls-post)).

---

## Important: when not to use this mechanism

**We strongly recommend treating `vendorSpecific.ultravox` as unsuitable for production agent design**, except for short-lived diagnostics, experiments, or tests.

- **Stability.** These fields mirror Ultravox’s request body. If Ultravox changes or removes fields, renames semantics, or tightens validation, behaviour can break **without** a coordinated release on our side. Agents that depend on a particular shape here are inherently fragile.

- **Portability.** Relying on vendor blocks makes an agent **non-portable** in practice: you are encoding assumptions about one provider’s API and lifecycle, not about Aplisay’s stable agent contract.

- **Cross-platform behaviour.** On stacks that are not Ultravox-backed LiveKit, `vendorSpecific` is generally **ignored**—so the same agent JSON may still “run” elsewhere. That is **not** the same as behaving the same. If **important** behaviour (for example a fixed welcome line encoded only in `firstSpeakerSettings`, or turn-taking tuned only via `vadSettings`) lives exclusively in these options, **other models or handlers will not reproduce it**, because those options are not applied there. Prefer putting durable behaviour in the **prompt**, **standard agent options**, and **tools** that every platform you care about supports.

Use vendor-specific knobs when you understand the trade-offs and accept that they may need revisiting whenever Ultravox or our integration changes.

---

## Overview

The `vendorSpecific` object on agent `options` is an opaque pass-through for provider-specific configuration. For LiveKit Ultravox agents, the worker forwards `vendorSpecific.ultravox` into the Ultravox realtime plugin, which merges supported keys into the Ultravox `POST /api/calls` body.

Supported keys today include (non-exhaustive; see implementation and Ultravox docs):

| Key | Purpose |
|-----|--------|
| `experimentalSettings` | e.g. experimental transcription provider selection |
| `vadSettings` | Call-level voice activity detection tuning |
| `firstSpeakerSettings` | Who speaks first and how the opening turn is shaped |

Other keys may be forwarded if added by Ultravox; treat undocumented keys as experimental.

---

## Configuration shape

```json
{
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "experimentalSettings": { },
        "vadSettings": { },
        "firstSpeakerSettings": { }
      }
    }
  }
}
```

Only include the sections you need. See the [Agent Options](https://llm.aplisay.com/api#/components/schemas/AgentOptions) schema in the API documentation for the general `vendorSpecific` field.

---

## Transcription (`experimentalSettings`)

Ultravox supports experimental transcription providers that can change transcription quality or provider. Configure them under `experimentalSettings` (see Ultravox and provider docs for current keys and values).

### Example: Deepgram Nova 3

Use Deepgram’s Nova 3 model for transcription while keeping your existing Ultravox model string (e.g. Llama-backed variants).

- Add `experimentalSettings.transcriptionProvider: "deepgram-nova-3"`.

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

### Example: GLM 4.6 with Ultravox transcription

- Use a model string such as `livekit:ultravox/ultravox-0.7` (per your deployment naming).
- Set `experimentalSettings.transcriptionProvider: "ultravox"` if you intend to use Ultravox’s native transcription path for that stack.

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

---

## VAD settings (`vadSettings`)

Optional call-level **voice activity detection** parameters are sent as Ultravox `vadSettings`. Field names and duration string formats match the [Create Call](https://docs.ultravox.ai/api-reference/calls/calls-post) request schema (for example `turnEndpointDelay`, `minimumTurnDuration`, `minimumInterruptionDuration`, `frameActivationThreshold`).

```json
{
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "vadSettings": {
          "turnEndpointDelay": "0.5s",
          "minimumTurnDuration": "0s",
          "minimumInterruptionDuration": "0.12s",
          "frameActivationThreshold": 0.5
        }
      }
    }
  }
}
```

---

## First speaker (`firstSpeakerSettings`)

Optional **opening-turn** behaviour is sent as Ultravox `firstSpeakerSettings` (preferred over the deprecated `firstSpeaker` enum on the create-call payload). Structure follows Ultravox: typically **exactly one** of `user` or `agent` should be set; nested fields include agent `text` / `prompt` / `delay` / `uninterruptible`, and under `user` an optional `fallback` for when the user does not speak first.

When `firstSpeakerSettings` is present on the agent, our LiveKit Ultravox integration sends that object and **does not** send the legacy `firstSpeaker` enum, to avoid mismatch rules in the Ultravox API.

```json
{
  "options": {
    "vendorSpecific": {
      "ultravox": {
        "firstSpeakerSettings": {
          "agent": {
            "text": "Hello, how can I help you today?"
          }
        }
      }
    }
  }
}
```

Again: if this greeting is **critical** to your product, duplicating or reinforcing the intent in the **system prompt** (or other portable mechanisms) reduces the risk of divergent behaviour on non-Ultravox routes.

---

## Summary

- Use `options.vendorSpecific.ultravox` only with the caveats above.
- Prefer portable configuration for anything that defines core product behaviour.
- For authoritative field lists and semantics, use the [Ultravox API reference](https://docs.ultravox.ai/api-reference/calls/calls-post) as the source of truth.
