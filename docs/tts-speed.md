# Speaking rate: `options.tts.speed`

`options.tts.speed` sets how fast the agent speaks, as a multiple of the voice's normal rate.

| Value | Effect |
|---|---|
| unset or `1` | Nothing is sent. The vendor's own rate applies. |
| `1.2` | 20% faster |
| `0.9` | 10% slower |

```json
{ "options": { "tts": { "vendor": "elevenlabs", "voice": "Rachel", "speed": 1.1 } } }
```

The API accepts `0.25` to `2`, the widest range any supported vendor takes. Each vendor has a
narrower range. The worker clamps the value to the vendor's range and logs a warning when it does.

The speed applies to whatever produces the agent's audio:

- On a pipeline model, the pipeline TTS.
- On a realtime model in text-output mode ([realtime-external-tts.md](realtime-external-tts.md)), the external TTS.
- On a realtime model with its own voice, the model.

Where a vendor or model has no speed control, the call goes ahead at normal speed and the worker
logs `options.tts.speed ignored`.

## Support

| Vendor or model | Range | LiveKit | Pipecat | Native (`ultravox:`) |
|---|---|---|---|---|
| ElevenLabs TTS | 0.7 to 1.2 | Provider-key mode only (`voiceSettings.speed`). Not on LiveKit Inference. | Yes | – |
| Cartesia TTS (sonic-3) | 0.6 to 1.5 | LiveKit Inference only (`modelOptions.speed`). Not in provider-key mode (see below). | Yes (`generation_config.speed`) | – |
| Deepgram Aura-2 TTS | 0.7 to 1.5 | No (see below) | Yes. Deepgram supports it on English and Spanish voices. | – |
| Neuphonic TTS | 0.7 to 1.5 | Yes | Yes | – |
| Google / Gemini TTS | – | No: Gemini TTS has no speed control | – | – |
| OpenAI Realtime | 0.25 to 1.5 | Yes | Yes | – |
| Grok voice (xAI) | 0.7 to 1.5 | – | Yes | – |
| Ultravox | by voice provider, below | Yes | Yes | Yes |
| Gemini Live | – | No: no speed control in the API | No | – |
| OpenAI GPT-Live | – | – | No | – |

### Ultravox

Ultravox has no call-level speed. The setting goes in `voiceOverrides` under the TTS provider behind
the chosen voice, and Ultravox refuses an override for any other provider. So the worker looks up
the voice's provider in the Ultravox voice catalogue (`GET /voices`), once per voice per process,
and places the speed there:

| Voice provider | Field | Range |
|---|---|---|
| ElevenLabs | `elevenLabs.speed` | 0.7 to 1.2 |
| Cartesia | `cartesia.generationConfig.speed` | 0.6 to 1.5 |
| LMNT | `lmnt.speed` | 0.25 to 2 |
| Google | `google.speakingRate` | 0.25 to 2 |
| Inworld | `inworld.speakingRate` | 0.5 to 1.5 |
| Respeecher | none | – |

Notes:

- The agent needs an explicit `options.tts.voice`. With the default voice, the speed is ignored.
- A failed lookup costs the speed, never the call.
- `vendorSpecific.ultravox.voiceOverrides` wins over `options.tts.speed` on all three stacks.
- See https://docs.ultravox.ai/api-reference/calls/calls-post.

### LiveKit agents-js 1.0.46 gaps

On the pinned agents-js 1.0.46 plugins:

- `@livekit/agents-plugin-cartesia` sends speed only in the sonic-2 `__experimental_controls` field, which sonic-3 ignores.
- `@livekit/agents-plugin-deepgram` has no speed option. It arrives in 1.3.2.
- LiveKit Inference has no speed option for ElevenLabs or Deepgram.

Those paths log a warning and speak at normal speed. The agents-js bump fixes the Cartesia and
Deepgram plugins.

## Code

- API validation: `lib/tts-speed.js` (`validateTtsSpeed`), called from the Agent model.
- LiveKit: `agents/livekit/lib/tts-speed.ts`. The Ultravox mapping is in `agents/livekit/plugins/ultravox/src/realtime/voice_speed.ts`.
- Pipecat: `agents/pipecat/pipecat_aplisay/tts_speed.py`.
- Native Ultravox: `lib/handlers/ultravox.js` (`applyTtsSpeed`).

The vendor range tables are copied in each of these files. Keep them in step.
