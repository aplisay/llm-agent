# Formatted transcripts: `formatted` and the Deepgram options

A speech recognition engine can return what the caller said as spoken words ("oh two oh, seven
nine four six, oh eight one oh") or written the way people write it ("02079460810"). Written
form is easier for a model to act on when the caller gives a phone number, a date, a time, an
amount of money or an email address.

Two kinds of option control this:

- **`formatted`** is portable. It asks any engine for written form, and the worker sends that
  engine whatever settings get it.
- **The Deepgram options** (`smart_format`, `punctuate`, `numerals`, `no_delay`, `endpointing`)
  pass Deepgram's own settings through one at a time. They work on Deepgram only.

## Where the options go

The same fields work in all three STT blocks:

| Block | Engine it sets up |
|---|---|
| `options.stt` | The pipeline STT on a pipeline model. Also the bridged-call transcription when it uses the agent's STT ([call-transfers.md](call-transfers.md)). |
| `options.stt.aux` | The auxiliary STT on the caller ([auxiliary-stt.md](auxiliary-stt.md)) |
| `options.tts.output` | The output audit STT on the agent ([auxiliary-stt.md](auxiliary-stt.md)) |

Each block stands alone. `options.stt.aux` and `options.tts.output` do not take `formatted` or the
Deepgram options from `options.stt`.

```json
{
  "options": {
    "stt": {
      "vendor": "deepgram",
      "language": "en-GB",
      "formatted": true,
      "aux": { "vendor": "deepgram", "formatted": true }
    },
    "tts": {
      "output": { "vendor": "deepgram", "formatted": true }
    }
  }
}
```

On a realtime model, the model does its own recognition and has no formatting setting. There,
`options.stt.formatted` affects only the bridged-call transcription. The two side engines are
separate STT engines, so they take the options on realtime models too.

## `formatted`

| Value | Effect |
|---|---|
| unset or `false` | Nothing is sent. The engine's own defaults apply (see [Deepgram defaults](#deepgram-defaults)). |
| `true` | Punctuation and capital letters, with numbers, phone numbers, dates, times, money, email addresses and web addresses in written form, as far as the engine can do it. |

What `true` sends to each engine:

| Engine | `options.stt` and `options.tts.output` | `options.stt.aux` |
|---|---|---|
| Deepgram (Nova models) | `smart_format=true`, `punctuate=true`, `no_delay=true` | The same, plus `endpointing=1500` |
| AssemblyAI Universal-Streaming | `format_turns=true` | The same. Turn settings still to be chosen (see [AssemblyAI](#assemblyai)). |
| Cartesia Ink Whisper | nothing | `max_silence_duration_secs=1.5` |
| Google (Pipecat only) | nothing | nothing |

The auxiliary engine gets a longer pause before each transcript ends. It hears the caller and is
not on the call path, so waiting costs the call nothing, and the longer pause is what makes
formatting work when a caller reads out details in pieces. See
[Pauses](#pauses-split-the-formatting).

Universal-3.5 Pro and Universal-3.6 Pro always format, so they get no `format_turns`. Cartesia
always formats. Pipecat already turns on Google's automatic punctuation, and Google writes numbers
as digits.

## Pauses split the formatting

Every engine here formats each final transcript on its own. A pause in speech ends a final
transcript. People read out an email address or a phone number in pieces, with a pause between
each, so each piece is formatted alone and the whole address or number is never seen at once.

A test on 16 November 2026 streamed synthesised dictation (pieces with pauses of 0.4 to 0.8
seconds) through each worker's own auxiliary STT code. Today, with no `formatted`, both workers
returned one transaction-log entry per piece:

```
jane dot smith
At example.
Dot com.
o seven seven zero zero
nine double o
one two three.
```

A prerecorded Deepgram request with `smart_format` on the same audio, which is what an
after-the-call transcription of a recording does, returned "jane.smith@example.com" and
"07700900123".

Deepgram's `endpointing` sets how long a pause ends a final transcript. The Deepgram routes use
25 ms (LiveKit) or Deepgram's default of 10 ms (Pipecat). Streamed straight to Deepgram:

| `endpointing` | Email | Mobile number | Final arrives after speech ends |
|---|---|---|---|
| 25 ms (LiveKit today) | 3 entries, words | 3 entries, words | about 0.3 s |
| 800 ms | 2 entries, words | 1 entry, words | about 1 s |
| 1000 ms | jane.smith@example.com | 1 entry, words | about 1.2 s |
| 1500 ms | jane.smith@example.com | 07700900123 | about 2 s (5 s for the mobile number) |
| 3000 ms | jane.smith@example.com | 07700900123, merged with the next sentence | 2 to 7 s |

At 1500 ms the booking reference and the date of birth came out formatted too. Only "forty two
pounds" and "fifty", with a pause between, still came back as two entries. So `formatted` sets
`endpointing=1500` on a Deepgram auxiliary engine. With `formatted`, the Pipecat auxiliary engine
and Deepgram on LiveKit Inference both returned this result.

The longer pause has a cost in the transaction log. Entries arrive later, and sometimes two
sentences arrive as one entry: in fluent speech, at every value from 800 ms up, a sentence that
ended in a phone number was held until the next sentence and joined to it. Both make it harder
to line `user-aux` entries up with the primary entries by time. Set `endpointing` in the block to
choose a different balance.

Cartesia Ink Whisper does the same with `max_silence_duration_secs`. With no value set, which is
what LiveKit Inference sends today, it split the dictation into short entries and lost some
pieces ("four five six", "fifty") and returned "dot com" as ".". At 1.5 seconds it lost nothing,
and returned "My email address is jane.smith." then "at example.com.". So `formatted` sets 1.5 on
a Cartesia auxiliary engine.

### The LiveKit Deepgram plugin

With `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` on, as on staging and production, LiveKit runs Deepgram
through its Deepgram plugin. The plugin stops sending audio 1 second after speech, to save audio
that is only silence. Deepgram then never hears a pause longer than 1 second, so with a longer
`endpointing` it holds each transcript until the caller speaks again, and joins each turn to the
next.

So when the plugin runs an auxiliary engine with a pause of 1000 ms or more, the worker finalizes
the transcript itself: it asks Deepgram for the final transcript once that long has passed since
the last speech it sent. On the dictation this returned one entry per sentence, about 1.5 to 2
seconds after the speech, with nothing lost or joined:

```
My email address is jane.smith@example.com.
My mobile number is o seven seven zero zero nine double o one two three.
The booking reference is four five six. Seven eight nine
I paid £42.50.
My date of birth is the 07/04/1986.
```

The email address, the money and the date come out formatted. Digit strings read out in groups
stay as words, because Deepgram formats them only after a pause of about 1.5 seconds, which the
plugin never sends. Deepgram on LiveKit Inference and the Pipecat worker send all the audio, so
they format the digit strings too.

### The output engine

`formatted` sets no longer pause on `options.tts.output`. The output engine hears audio only while
the agent speaks, so after the agent's last word there is no silence to end the transcript, and a
longer pause would hold it until the agent speaks again. The agent's speech is synthesised from
text and has few pauses inside a number or address, so the default pause serves it.

### The pipeline STT

`formatted` leaves the pause settings alone on `options.stt`. The agent cannot reply until the
pipeline STT sends its final transcript, so a longer pause there would slow every reply. Details
read out in pieces still reach the pipeline STT as separate finals, each formatted on its own. The
model receives the pieces joined into one turn.

## Deepgram

### Deepgram options

Each field is sent to Deepgram under the same name. A value you set wins over what `formatted`
would send, so `"formatted": true, "endpointing": 1000` in `options.stt.aux` sends
`smart_format=true`, `punctuate=true`, `no_delay=true` and `endpointing=1000`.

| Field | Type | What it does |
|---|---|---|
| `smart_format` | boolean | Punctuation, plus numbers, dates, times, money, phone numbers, email addresses and web addresses in written form. English gets all of these. Other languages get what Deepgram has for them. |
| `punctuate` | boolean | Punctuation and capital letters. |
| `numerals` | boolean | Spoken numbers as digits. |
| `no_delay` | boolean | Send each final transcript at once, without waiting to see whether a number or address is complete. |
| `endpointing` | integer (milliseconds) or `false` | How long a pause ends a final transcript. `false` leaves the timing to Deepgram. |

The API refuses these fields with HTTP 400 in a block whose `vendor` names another engine. A block
with no `vendor` uses Deepgram, so it accepts them.

Setting `endpointing` on `options.stt` changes when the pipeline STT sends finals, and so how soon
the agent replies. Test turn-taking before you raise it there. On the LiveKit Deepgram plugin,
a value of 1000 ms or more on `options.stt` or `options.tts.output` holds each transcript until
the next speech (see [The LiveKit Deepgram plugin](#the-livekit-deepgram-plugin)). Only the
auxiliary engine finalizes itself.

The Deepgram Flux models (`deepgram/flux-*`) take none of these settings. The worker leaves them
out and logs a warning.

### Deepgram defaults

When none of the fields is set, each route sends its own defaults:

| Route | Model | `punctuate` | `smart_format` | `numerals` | `no_delay` | `endpointing` |
|---|---|---|---|---|---|---|
| LiveKit, Deepgram plugin (`LIVEKIT_PIPELINE_USE_PROVIDER_KEYS`) | nova-3 | on | on | off | on | 25 ms |
| LiveKit, Deepgram on LiveKit Inference | nova-3 | on | off | off | on | 25 ms |
| Pipecat | nova-3-general | on | off | off | not sent (off) | not sent (10 ms) |

These defaults apply to all three blocks: the workers build the side engines the same way as the
pipeline STT. So on Pipecat the auxiliary and output engines never format. On LiveKit with
provider keys they have `smart_format` on, but the 25 ms pause splits dictated details as shown
in [Pauses](#pauses-split-the-formatting).

`formatted: true` sends the same settings on all three routes. Leaving `formatted` unset changes
nothing on any route.

### Why `formatted` leaves out `numerals`

`smart_format` already writes numbers as digits. In the same tests, adding `numerals` made English
worse:

| Spoken | `smart_format` | `smart_format` and `numerals` |
|---|---|---|
| half past seven | half past seven | 0.5 past 7 |
| oh two oh, seven nine four six, oh eight one oh | 02079460810 | 0 2 0 7 9 4 6 0 8 1 0 |

In French and German the output was the same with and without `numerals`. Set `numerals: true`
yourself if a language needs it.

### Why `formatted` keeps `no_delay` on

With `no_delay` off, Deepgram holds back a final transcript that might end in an unfinished number
or address, until 3 seconds of silence or more speech. With the 25 ms pause, finals that ended in
a date were held for 5 to 10 seconds. That would slow the agent's reply on the pipeline STT. With
a 1500 ms pause, turning `no_delay` off formatted nothing more, and it merged "fifty" into the next
sentence. So `formatted` keeps it on everywhere.

## AssemblyAI

LiveKit sends AssemblyAI requests through LiveKit Inference. The model the platform uses is
Universal-Streaming (`assemblyai/universal-streaming`). AssemblyAI documents its `format_turns`
setting as off by default, and `formatted: true` turns it on.

In the dictation test on Inference, Universal-Streaming already returned capital letters and
digits without `format_turns` ("My mobile number is 07700."). Turning it on added end punctuation
and the dot in "Jane.smith.", and changed little else. Neither setting joined the pieces: the
email address and the mobile number each came back in three entries.

AssemblyAI ends turns by its own model, not by a fixed pause. LiveKit lowers AssemblyAI's
end-of-turn threshold from 0.4 to 0.01, so turns end at short pauses. The auxiliary engine's turn
settings (`end_of_turn_confidence_threshold`, `min_end_of_turn_silence_when_confident`,
`max_turn_silence`) will be chosen from a test on staging.

Universal-3.5 Pro and Universal-3.6 Pro always return formatted text and have no setting for it.
Pipecat does not offer AssemblyAI.

## Cartesia

Ink Whisper (`cartesia/ink-whisper`, the model the platform uses) always returns formatted text,
and Cartesia has no setting to change it. In the tests it returned "020-7946-0810", "the 23rd of
December at half past seven", "42 pounds 50" and "312 people" from fluent speech. On the auxiliary
engine `formatted` sets `max_silence_duration_secs` (see [Pauses](#pauses-split-the-formatting)).
Pipecat does not offer Cartesia STT.

## Support

| | LiveKit | Pipecat |
|---|---|---|
| `formatted` | Deepgram (plugin or Inference), AssemblyAI, Cartesia | Deepgram, Google |
| Deepgram options | Deepgram plugin and Deepgram on Inference | Deepgram |

Native `ultravox:`, `jambonz:` and `text:` models have no pipeline STT and no side engines, so they
ignore `options.stt.formatted` and the Deepgram options.

## Code

- API validation: `lib/stt-formatting.js` (`validateSttFormatting`), called from the Agent model
  in `lib/database.js` for `options.stt` and both side blocks.
- LiveKit: `agents/livekit/lib/stt-formatting.ts` maps the fields to the Deepgram plugin's
  options and to LiveKit Inference `modelOptions`. `pipeline-routing.ts` and
  `pipeline-provider-keys.ts` apply them. `aux-stt.ts` carries them from the side blocks, asks
  for the longer pause on the auxiliary engine, and finalizes it on the Deepgram plugin
  (`selfFinalizeAfterMs`, `startSideSttEngine`).
- Pipecat: `agents/pipecat/pipecat_aplisay/stt_formatting.py`, applied in `build_stt_service`
  (`voice_session.py`). `aux_stt.py` carries the fields from the side blocks. `no_delay` goes on
  the Deepgram URL through the SDK's `additional_query_parameters`, because the SDK has no
  argument for it.

The engine mapping is written out in both workers. Keep the two in step with the tables above.
