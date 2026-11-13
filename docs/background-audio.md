# Background sound: `options.backgroundAudio`

`options.backgroundAudio` plays a quiet office sound to the caller. A few
seconds of silence while the agent waits for a model reply or a tool result can
sound like a dropped call. The sound tells the caller the line is still open.

```json
{ "options": { "backgroundAudio": true } }
```

```json
{ "options": { "backgroundAudio": { "when": "silent", "volume": "low", "delayMs": 300 } } }
```

## The option

| Field | Values | Default | Meaning |
|---|---|---|---|
| `enabled` | `true`, `false` | `true` | `false` turns the sound off without removing the object. |
| `sound` | `office` | `office` | The sound to play. Only one is available. |
| `volume` | `low`, `medium`, `high` | `medium` | About -46, -40 and -34 dBFS mean level. |
| `when` | `thinking`, `silent`, `always` | `thinking` | When the sound plays. See below. |
| `delayMs` | `0` to `10000` | `600` | How long the condition for `thinking` or `silent` must hold before the sound starts. |

`true` means all the defaults. Leaving the option out, `false`, or
`enabled: false` turns it off, and the call behaves exactly as it does without
the feature. An unknown value or a number out of range is refused when the
agent is saved.

## When the sound plays

| `when` | The sound plays |
|---|---|
| `thinking` | Only while the agent is working: a tool call is running, or the reply has taken longer than `delayMs`. It stops when the agent or the caller speaks. |
| `silent` | Whenever the agent is not speaking, after `delayMs` of quiet. It keeps playing while the caller speaks. |
| `always` | For the whole call, under the agent's speech too. `delayMs` is ignored. |

In every mode the sound is off:

- while a transfer is being placed or a consultation is in progress,
- while the caller is bridged to another person, for the rest of the call,
- while the confidence tone covers an agent handover (`options.transferTone`),
- once the agent has hung up or the call is ending.

The sound fades in over 300 ms and out over 120 ms. Each call starts at a
random point in the clip, and the clip carries on from where it stopped each
time the sound comes back, so the caller does not hear the same few seconds at
every pause.

### How the agent counts as working

`thinking` mode needs to know when the agent owes the caller something.

- A tool call counts while it runs, on every model.
- On a LiveKit pipeline model (separate speech-to-text, LLM and text-to-speech),
  the time the LLM takes to answer counts.
- On realtime models, and on every model on the Pipecat worker, the time from
  the end of the caller's turn until the agent is heard counts. If the agent
  never answers, this stops counting after 20 seconds.

A noise that the system takes for the caller speaking, with no reply after it,
can therefore start the sound for a while. Raise `delayMs` if this happens.

### Agent handovers

Agents in a set can each set the option differently. After a `transfer_agent`
handover, the incoming agent's own setting applies. An incoming agent without
the option plays no sound.

On Pipecat, a handover that keeps the same model normally swaps the prompt and
tools in place. When the outgoing agent had no background sound and the
incoming agent has one, the handover restarts the agent stack instead, with a
child call record, because the sound cannot be added to a running pipeline.

## Where it works

| Runtime | Supported |
|---|---|
| LiveKit worker (`livekit:` models) | Yes, phone and browser calls |
| Pipecat worker (`pipecat:` models) | Yes, phone and browser calls |
| jambonz | No, the option is ignored |
| Native Ultravox (`ultravox:` models) | No, the option is ignored |

### Recordings

The two workers record differently:

- **Pipecat**: call recordings include the sound, because it is part of the
  agent's audio stream.
- **LiveKit**: call recordings do not include the sound. It is played on a
  separate audio track, which the recorder does not capture. To judge how it
  sounds, listen on a live call.

### The output audit

With `options.tts.output` ([auxiliary-stt.md](auxiliary-stt.md)) on the Pipecat
worker in `always` mode, the audit engine hears the sound under the agent's
speech, because that is what the caller hears.

### GPT-Live on Pipecat

GPT-Live sends a continuous audio stream, silences included. The sound is
carried in the stream's silences once the agent's turn is over. In `always`
mode it drops out during pauses inside the agent's turn, and for about a third
of a second after the turn ends.

## Echo

In `silent` and `always` modes the sound plays while the caller speaks. A
speakerphone or a poor handset can feed it back into the caller's microphone.
The speech recogniser and the voice activity detector then hear it too, which
can cause false interruptions or stray words in the transcript.

Keep the volume at `low` or `medium` for these modes. Prefer `thinking` where
callers use speakerphones, because it never plays while the caller speaks.

## Cost

The two workers carry the sound differently, so they cost differently.

**LiveKit.** The sound has its own audio track, published when the call
connects and kept for the whole call. While the sound is off the player itself
does nothing: no timer runs and it writes no audio. But LiveKit's audio source
still feeds the track's encoder 10 ms of silence every 10 ms, so a call with
the option carries a second encoded stream from start to end, sound or no
sound. While the sound plays, each 50 ms frame is a copy of a buffer that
already has the volume applied.

**Pipecat.** There is no second stream. While the sound is off nothing is sent
and no timer runs. While it plays, the sound goes out on the agent's existing
output stream: in the gaps as extra audio frames, and under the agent's speech
by adding it to the speech frames.

On both workers only the fades scale samples one by one. The rest of the cost
follows how long the sound plays:

- `thinking` is the cheapest. The sound plays for a small part of the call.
- `silent` plays whenever the agent is quiet, often half the call or more.
- `always` is the dearest. On Pipecat it also mixes the sound into every frame
  of the agent's speech.

## The sound

The office clip comes from the `@livekit/agents` package (Apache-2.0). It is
converted to a 16 kHz mono WAV with a crossfaded loop point and committed in
each worker under `assets/background/`, with a copy of the Apache-2.0 licence
beside it. `scripts/make-background-audio.sh` rebuilds it; it needs `ffmpeg`
and `ffprobe` on `PATH`.
