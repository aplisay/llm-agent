# LiveKit pipeline models: API implications

This document explains what changed in the public API when **LiveKit pipeline** (STT–LLM–TTS) models were added alongside existing **LiveKit realtime** (speech-to-speech) models.

## Summary

- **New LiveKit model variants** exist under the same `livekit:` handler prefix.
- You can tell **pipeline vs realtime** apart via model metadata (`voiceStack`, `requiresSttTts`).
- Pipeline allow more significant config in `options.stt` and `options.tts`; realtime models only use this option for voice name as the voice is provider-native.
- Voice selection should use **model-scoped** endpoints, not `GET /voices`. These give the available `tts` options for a given model string rather than the deprecated comprehensive /voices endpoint. See [`docs/voices-deprecation.md`](./voices-deprecation.md).

## Model ids and how to tell them apart

### Model id shape

LiveKit models are addressed by the `modelName` string on the agent, shaped like:

- `livekit:<provider>/<modelId>`

Examples:

- `livekit:openai/gpt-realtime` (realtime)
- `livekit:ultravox/ultravox-v0.7` (realtime)
- `livekit:openai/gpt-4o-mini` (pipeline)
- `livekit:google/gemini-2.5-flash` (pipeline)

### Use `GET /models` flags (recommended)

The authoritative way to distinguish model stacks is to call `GET /models` and read these fields:

- **`voiceStack`**: `"realtime"` or `"pipeline"`
- **`requiresSttTts`**:
  - `true` for pipeline models (you must configure STT/TTS options, or accept defaults)
  - `false` for realtime models (speech-to-speech; STT/TTS are built in)
- **`audioModel`**:
  - typically `true` for realtime
  - typically `false` for pipeline

## Agent options differences

### Realtime models (`voiceStack: realtime`)

Realtime models are speech-to-speech:

- **LLM**: determined by `modelName` (`livekit:openai/...`, `livekit:ultravox/...`, `livekit:google/...`)
- **STT/TTS**: provider-native and not selected via the pipeline STT/TTS catalogue
- **Voice**:
  - Ultravox, OpenAI realtime use `options.tts.voice` to select as the voice name only (e.g. `alloy`)

### Pipeline models (`voiceStack: pipeline`)

Pipeline models are STT–LLM–TTS:

- **LLM**: always derived from `modelName` (the provider/model segment after `livekit:<provider>/`)
- **STT**: Engine configured via `options.stt` (usually with a default if not selected)
- **TTS**: Voice *and* engine configured via `options.tts` 

#### `options.stt`

Supported shape:

- `options.stt.language`: language / locale hint (used to derive the STT model suffix)
- `options.stt.vendor`:
  - plain vendor name (default is `deepgram`)
    - examples: `deepgram`, `assemblyai`, `cartesia`
  - optional scoped model selection using `vendor/model[:suffix]`
    - examples:
      - `deepgram/nova-3:en`
      - `deepgram/nova-3` (suffix derived from `options.stt.language`)

Notes:

- If you omit `options.stt.vendor`, the default is at this time `deepgram` → `deepgram/nova-3:<derivedLang>`.

#### `options.tts`

Supported shape:

- `options.tts.language`: language / locale hint (used by some providers)
- `options.tts.voice`: the voice identifier (provider-specific)
- `options.tts.vendor`:
  - plain vendor name
    - examples: `cartesia`, `elevenlabs`, `deepgram`, `google`
  - optional scoped model selection using `vendor/model`
    - examples:
      - `cartesia/sonic-3`
      - `deepgram/aura-2`

Notes:

- `google` in the Node pipeline uses **Gemini TTS** (not Google Cloud voice catalogue ids). Voice selection is mapped via environment/vendor-specific configuration.

## Voices and locales APIs

`GET /voices` is deprecated and intentionally returns a legacy merged catalogue for backward compatibility.

For correct UI / validation, use model-scoped endpoints:

- `GET /models/{modelName}/voices` → locale list for the selected model
- `GET /models/{modelName}/voices/{locale}` → vendor-keyed voices list of available engines and voices for that model + locale

See [`docs/voices-deprecation.md`](./voices-deprecation.md) for details and examples (including URL-encoding `modelName`).

## Common integration patterns

- **Model picker**:
  - call `GET /models`
  - render LiveKit models grouped by `voiceStack`
- **When a model is selected**:
  - if `requiresSttTts` is true, show STT/TTS configuration UI (vendor, locale, voice)
  - refresh the voice UI from `GET /models/{modelName}/voices` + `.../{locale}`
- **Validation expectation**:
  - pipeline: changing `options.stt` / `options.tts` affects the session configuration
  - realtime: only certain provider-native options apply; STT/TTS vendor selection is not relevant
