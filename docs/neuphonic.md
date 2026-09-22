# Neuphonic TTS

[Neuphonic](https://www.neuphonic.com/) is a TTS vendor. Set `options.tts.vendor` to
`neuphonic` to use it:

- on pipeline models on both workers (`livekit:` and `pipecat:` pipeline rows);
- as the voice of a realtime model in text-output mode, on the rows that
  `GET /models` flags `hasExternalTts` (Ultravox and OpenAI Realtime, on both
  workers; see [realtime-external-tts.md](realtime-external-tts.md));
- for the fallback announcement, `options.fallback.message`, on any LiveKit or
  Pipecat agent (see [agent-failover.md](agent-failover.md)).

It is not available on jambonz agents, the native `ultravox:` handler, Gemini
Live, Grok voice or GPT-Live.

## Configuration

```json
{
  "tts": {
    "vendor": "neuphonic",
    "voice": "79ffd956-872a-4b89-b25b-d99bb4335b82",
    "language": "en-GB"
  }
}
```

- `voice` is a Neuphonic voice id. `GET /models/{modelName}/voices/{locale}` lists
  the voices under the `neuphonic` vendor. With no `voice`, Neuphonic uses its
  default voice for the language. Some languages have no default voice, so set
  one.
- `language` must be a language the voice speaks. The workers send its base code:
  `en-GB` is sent as `en`. When it is unset they use `options.stt.language`, then
  English.
- Each voice is listed under a locale made from its language and its accent tag:
  a British voice is under `en-GB`, a Venezuelan one under `es-VE`. A voice with no
  accent tag is under the usual region for its language (`de-DE`, `ja-JP`).
- Only Neuphonic's stock voices are listed. Voices cloned on the account are not,
  because every organisation sees the same catalogue.

## Environment

Set `NEUPHONIC_API_KEY` for:

- the API server, which lists the voices. Without the key the vendor still passes
  validation, but no Neuphonic voice id does;
- the LiveKit worker;
- the Pipecat worker.

The server caches the voice list for ten minutes.

## How the workers call Neuphonic

Neuphonic says nothing until it gets the end of an utterance (`<STOP>` on its
websocket, or the end of an SSE request), so both workers send one sentence at a
time.

- **Pipecat** uses Pipecat's `NeuphonicTTSService`: one websocket per session,
  each sentence sent with `<STOP>`. The worker asks for 16 kHz audio, the
  transport rate, and sends lowercase base language codes. Pipecat 1.10 maps
  Hindi to `HI`, which Neuphonic accepts but does not speak as Hindi.
- **LiveKit** uses its own class, `agents/livekit/lib/neuphonic-tts.ts`, rather
  than `@livekit/agents-plugin-neuphonic`. It sends one SSE request per sentence,
  fetches the next sentence while the current one plays, and asks for 22.05 kHz
  audio. The plugin's websocket stream (at agents-js 1.0.46, and still at 1.9.0)
  sends a single `<STOP>` after the whole reply, so a long reply stays silent until
  the LLM has finished. Its SSE path throws from a socket handler when Neuphonic
  reports an error, which ends the job process. The class also does not use the
  agents-js sentence adapter, which in 1.0.46 meters each reply twice.

Neuphonic reports a bad voice, language or key, and an account with no credit
left, as `event: error` with status 500 inside an HTTP 200 SSE stream; the
websocket handshake fails with 403. The voice list still works in all these
cases. The LiveKit class retries the error like any 5xx; after the retries the
reply ends with a `tts_error`.

## Billing

Usage rows are `tts|neuphonic`, in characters and in milliseconds, like the other
TTS engines, and the rate-card roster offers `tts:neuphonic`. The cards price TTS
per character with a zero minute line.
[`scripts/add-neuphonic-rate-lines.mjs`](../scripts/add-neuphonic-rate-lines.mjs)
adds both lines to the default card and to every card that prices TTS. Neuphonic
publishes no per-character price, so the script copies each card's Cartesia
character price. `NEUPHONIC_CHARACTER_PRICE_MICROS` sets a price instead, and
`DRY_RUN=1` prints the plan without writing it.

```
node scripts/add-neuphonic-rate-lines.mjs -p /path/to/.env
```

## Limits

- Neuphonic sends no word timings, so the text logged for an interrupted reply is
  accurate to the sentence, not the word.
- Voice cloning on Neuphonic is English only, and cloned voices are not listed
  (see above).
