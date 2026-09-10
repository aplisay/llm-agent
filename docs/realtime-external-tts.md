# Realtime models with an external TTS

A realtime (speech-to-speech) model normally speaks with its own voice. Some
of them can instead emit text, and let a separate text-to-speech engine speak
it. This lets an agent keep a realtime model's listening and turn-taking while
using any TTS voice the platform offers.

## The rule

On a realtime model, `options.tts.vendor` decides:

| `options.tts.vendor` | Result |
|---|---|
| unset | the model's own voice |
| the model's own provider (`ultravox` on an Ultravox model, `openai` on OpenAI Realtime, `google` on Gemini Live) | the model's own voice |
| any other TTS vendor the worker supports (`elevenlabs`, `deepgram`, `cartesia`) | text-output mode: the model emits text and that TTS speaks it |

In text-output mode `options.tts.voice` and `options.tts.language` belong to
the external TTS. The language is also still passed to the model as its
recognition hint where the provider has one.

The session stays a realtime session: `voiceMode` is still `realtime`, the
provider still owns turn detection, and tools, transfers, recording and the
audit transcripts all work as before.

## Which models

`GET /models` marks the rows that support it with `hasExternalTts: true`.
Today that is the Ultravox rows and the OpenAI Realtime row on both voice
workers (`pipecat:ultravox/...`, `pipecat:openai/gpt-realtime`,
`livekit:ultravox/...`, `livekit:openai/gpt-realtime`). A realtime row
without the flag accepts only its own provider as `tts.vendor`; the API
rejects anything else when the agent is saved, with the fix in the message.

The Gemini Live rows do not carry the flag. No Live model Google still serves
accepts a text response modality: the half-cascade models have been
withdrawn and the native-audio model rejects it.

`GET /models/{modelName}/voices/{locale}` lists, for a flagged row, the
model's own voices and the discrete TTS catalogue side by side, keyed by
vendor. Picking a voice from one of the TTS vendors is what switches the
model to text output.

## Example

```json
{
  "modelName": "pipecat:ultravox/ultravox-v0.7",
  "prompt": "You are the front desk for Acme Dental.",
  "options": {
    "tts": {
      "vendor": "deepgram",
      "voice": "aura-athena-en",
      "language": "en-GB"
    },
    "greeting": { "text": "Thank you for calling Acme Dental." }
  }
}
```

The greeting, the inactivity prompts and the time-exceeded line are still
produced by the model. They arrive as text and the TTS speaks them.

## What changes on the call

- **Latency.** The TTS adds its own time to first byte on every turn, on top
  of the model's. Expect the agent to start speaking later than it does with
  the model's own voice.
- **Barge-in.** OpenAI Realtime reports the caller's speech itself, and that
  stops the TTS at once on both workers. Ultravox gives no such signal once
  its text turn is complete, so the two workers differ. The Pipecat worker
  runs its own voice activity detection on the caller's audio: deliberate
  speech stops the TTS at once, and its threshold sits close to Ultravox's
  own, so a cough or a short backchannel does not cut the agent off. The
  LiveKit worker has no local detector and stops the TTS when Ultravox
  delivers the caller's transcript, which arrives about a second after the
  caller stops speaking; a caller who interrupts while the model is still
  producing text is stopped at once on both workers.
- **What the model believes was said.** The model produces its whole reply as
  text in a second or two, long before the TTS has finished reading it. If the
  caller interrupts, the model's own history still holds the full reply, so it
  may refer back to something the caller never heard. The transcript logged
  for the call records what the TTS actually spoke, so the log stays truthful.
- **Usage.** TTS characters and audio are metered against the external
  vendor and priced by that vendor's rate lines. The model's own charge is
  unchanged.

## Not covered

- The native `ultravox:` handler (browser or Jambonz straight to Ultravox)
  has no worker in the media path, so it cannot host a TTS.
- The Gemini Live rows, for the reason above.
