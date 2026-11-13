# Background sound: `options.backgroundAudio`

`options.backgroundAudio` plays a quiet office sound to the caller. A few
seconds of silence while the agent waits for a model reply or a tool result can
sound like a dropped call. The sound tells the caller the line is still open.

Use `thinking` at `low` volume for normal service deployments. `thinking` is
the default mode whenever background audio is enabled. It covers longer reply
gaps while keeping the caller's speech and the agent's answer as clear as
possible:

```json
{
  "options": {
    "backgroundAudio": { "when": "thinking", "volume": "low", "delayMs": 600 }
  }
}
```

This is the recommended configuration. The shorthand `backgroundAudio: true`
uses **medium** volume, `thinking` mode and a 600 ms delay. The feature is off
unless you enable it. It changes what the caller hears during a wait; the
model and tool still take the same time to answer.

## Choose a mode

| Mode | When to use it | Trade-off |
|---|---|---|
| `thinking` — default and recommended | Reassure the caller during slow model replies or tool calls. Use `low` volume and `delayMs: 600` initially. | The sound fades out when caller or agent speech is detected. Short waits stay quiet. |
| `silent` — discouraged unless essential | Only when ambience while the caller speaks is an essential requirement. | The sound can return through the caller's microphone and degrade recognition and turn detection. |
| `always` — discouraged unless essential | Only when ambience under both sides of the conversation is an essential requirement. | Carries the caller-side echo risk of `silent` and can also mask or distort the agent's voice. |

In service-provider deployments, callers' handsets, speakerphones and echo
cancellation are usually outside your control. Equipment changes or individual
caller troubleshooting are rarely a practical remedy. Prefer `thinking`;
avoid `silent` and `always` unless their added ambience is essential enough to
justify the risk of poorer conversations. A successful test call cannot
establish that either mode will work well for every caller.

## Enable it through the API

Set `options.backgroundAudio` in your agent creation payload for
`POST /api/agents`, alongside your other options such as `stt`, `tts` and
`recording`. The JSON example above can be included in your usual agent
definition with its `modelName` and `prompt`. The feature needs no additional
provider key or audio download.

Use a working voice agent whose model is listed by `GET /api/models` and
starts with `livekit:` or `pipecat:`. See [Where it works](#where-it-works).
If you are starting from scratch, follow the
[local quickstart](self-hosting/quickstart-local.md#talk-to-an-agent) first.

To turn the sound off, use `backgroundAudio: false` or an object with
`"enabled": false`. You can change an existing agent through
`PUT /api/agents/{agentId}`; changes apply to new calls, not a call already
running. This is an agent setting across its listeners, with no per-listener
override in `POST /api/agents/{agentId}/listen`.

## The option

| Field | Values | Default | Meaning |
|---|---|---|---|
| `enabled` | `true`, `false` | `true` | `false` turns the sound off without removing the object. |
| `sound` | `office` | `office` | The sound to play. Only one is available. |
| `volume` | `low`, `medium`, `high` | `medium` | About -46, -40 and -34 dBFS mean level. This sets the background sound, not the agent's voice. Start at `low` and listen on the target device. |
| `when` | `thinking`, `silent`, `always` | `thinking` | Keep the default for normal service use. `silent` and `always` are discouraged unless essential because they can degrade speech or recognition. |
| `delayMs` | JSON number from `0` to `10000` | `600` | How long the condition for `thinking` or `silent` must hold before the fade-in starts. It applies to tool waits too. Ignored in `always` mode. |

`true` means all the defaults. Leaving the option out, `false`, or
`enabled: false` turns it off, and the call behaves exactly as it does without
the feature. An invalid value for a recognised field or a number out of range
is refused when the agent is saved. Values are case-sensitive: use `thinking`,
not `Thinking`, and `600`, not `"600ms"`. Unknown field names are currently
ignored: `delayMS`, for example, leaves the default `delayMs` in effect.
Likewise, `enable: false` does not disable the sound; use `enabled: false` or
`backgroundAudio: false`. Check spelling even when a save succeeds.

Both `true` and `{}` enable the defaults. `enabled: false` still needs valid
values for any other fields you include. The sound is always the bundled
office clip; custom files, URLs, numeric volume levels and per-call random
sound choices are not supported.

## When the sound plays

| `when` | The sound plays |
|---|---|
| `thinking` | Only while the agent is working: a tool call is running, or a reply is pending, for at least `delayMs`. It fades out when agent or caller speech is detected. |
| `silent` | Whenever the agent is not speaking, after `delayMs` of quiet. It keeps playing while the caller speaks. |
| `always` | For the whole call, under the agent's speech too. `delayMs` is ignored. |

In every mode the sound is off:

- while a transfer is being placed or a consultation is in progress,
- while the caller is bridged to another person,
- while the confidence tone covers an agent handover (`options.transferTone`),
- once the agent has hung up or the call is ending.

The sound fades in over 300 ms and out over 120 ms. Each call starts at a
random point in the clip, and the clip carries on from where it stopped each
time the sound comes back, so the caller does not hear the same few seconds at
every pause.

Speech detection and already queued audio take time, so even `thinking` can
briefly overlap the start of someone's speech. `delayMs` is a wait before the
fade-in, not the total time until the sound reaches full volume.

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

The last rule needs the model to report when the caller starts and stops
speaking. Ultravox realtime models do not report it when they speak with their
own voice, which is the default. On those models, on both workers, only tool
calls count:

- The sound plays during a tool call that runs for longer than `delayMs`. A
  wait with no tool call stays quiet, however long the reply takes.
- The sound does not stop when the caller speaks during a tool call. It stops
  when the tool call ends or the agent speaks.

Other realtime models may have the same limit. Check yours on a test call with
a slow reply and a slow tool.

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
| Text models (`text:`) | No audio output |

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

## Audio quality: what can go wrong

### Agent speech becomes harder to hear in `always` mode

In `always` mode the background sound plays under the agent's words. This
reduces the contrast between speech and background, particularly for a quiet
voice or a narrowband phone connection. Names, digits and short words can be
harder to distinguish even when the generated voice itself is clean.

On Pipecat the sound is added to the agent's samples, and a combined peak
above the 16-bit range is clipped. A loud voice can therefore become distorted
when mixed with the sound. LiveKit publishes separate tracks, but they still
meet at the caller's playback device or phone gateway, where the combined
audio can also lose clarity.

This makes `always` undesirable for normal service use, especially when names,
numbers and short answers must be heard accurately. Use it only when sound
under the agent's speech is essential. If speech becomes muffled, distorted
or hard to follow, switch to `thinking` or turn the feature off. Lower volume
may lessen the effect, but cannot guarantee clear speech for every caller.

### Caller input degrades with poor echo cancellation

In `silent` and `always` modes the sound plays while the caller speaks. A
speakerphone or a poor handset can feed it back into the caller's microphone.
If acoustic echo cancellation cannot remove it, the speech recogniser or
realtime model hears it alongside the caller. Words may be missed or
misrecognised, and the voice activity detector can mistake it for speech,
causing false interruptions or turns that never seem to finish.

`silent` avoids playing under the agent's voice, but still carries this
caller-side risk. Both modes can make a previously reliable conversation
worse on equipment the service provider cannot inspect or change. Transcript
entries or interruptions while the person is quiet can be signs of this
problem.

The practical service-side response is to use `thinking` at `low`, or disable
background sound if recognition remains worse than the baseline. Reducing the
background volume can help, but does not make `silent` or `always` reliable
across unknown caller equipment. Reserve them for essential requirements and
accept that some callers may experience degraded input.

The background audio option does not configure echo cancellation. Noise
suppression alone is not a guarantee that playback echo is removed; see LiveKit's
[noise and echo cancellation guide](https://docs.livekit.io/transport/media/noise-cancellation/).

## Check it on a real call

1. Make a call with the feature off. Confirm that the agent's voice and the
   caller's transcript are clear before adding background sound.
2. Enable `thinking` at `low` and start a new call. Ask something that takes
   longer than `delayMs` to answer, or exercise one of your existing slower
   tools. Expect sound during the wait and a fade-out when speech is detected.
   A fast answer may have no sound at all. On an Ultravox realtime model use a
   slow tool: a slow reply alone does not start the sound there (see
   [How the agent counts as working](#how-the-agent-counts-as-working)).
3. Only if `silent` or `always` is essential, assess the risk using the caller
   devices and phone routes available for testing. Speak names, numbers and
   short answers, then stay quiet. Compare recognition and interruptions with
   the baseline. These tests cannot cover all caller equipment; keep
   `thinking` as the normal service configuration.
4. For `always`, listen to complete agent replies on the actual browser or
   phone route. On LiveKit the recording and output audit omit the background
   track, so use live listening to judge the combined audio. On Pipecat the
   recording includes the sound.
5. If you use transfers or agent handovers, exercise them too. Confirm that
   the sound stops during a transfer and that the incoming agent's setting
   applies on handover. Make another new call after each configuration change.

For local LiveKit calls, the quickstart's browser test page plays both speech
and background tracks. For Pipecat, use your existing browser client or phone
route; that test page supports LiveKit only.

## Troubleshooting

| Symptom | Check and action |
|---|---|
| The API accepted the option but there is no sound | Confirm the agent's model uses a supported runtime, the setting is in the agent's options, and you started a new call. Unsupported runtimes silently ignore it. |
| `thinking` stays quiet | It plays only during a detected wait longer than `delayMs`. Let the agent finish speaking and exercise a slow reply or tool; idle silence alone does not trigger it. On Ultravox realtime models only a tool call that runs for longer than `delayMs` triggers it. |
| A custom LiveKit client plays speech but no background | Play the separate `background-audio` track as well as the speech track. A client that subscribes to or plays only the microphone track will miss it. |
| Agent speech is harder to understand | Reduce `volume`, or switch from `always` to `thinking`. Compare live audio with the feature off. |
| Caller recognition worsens or the agent interrupts itself | Playback echo from `silent` or `always` may be entering the caller's microphone. Switch to `thinking` at `low`, or disable the feature; caller-equipment changes are usually impractical. |
| Sound starts after noise or in short bursts | A false caller turn can count as pending work. Check input audio and echo first; increasing `delayMs` can keep short false waits quiet. |
| A saved setting seems to have no effect | Check field names and case. Unknown keys are ignored. `delayMs` has no effect in `always` mode. |
| LiveKit's recording has no office sound | Expected: it omits the separate background track. Listen on a live call. |
| A new call still has no sound after these checks | Check the worker log for `background audio` messages, including missing-asset or track-publication errors. A playback failure is logged and the call continues without the sound. |

## Cost

The two workers carry the sound differently, so they cost differently.

**LiveKit.** The sound has its own audio track, published when the call
connects and kept for the whole call. While the sound is off the player itself
does nothing: no timer runs and it writes no audio. But LiveKit's audio source
still feeds the track's encoder 10 ms of silence every 10 ms, so a call with
the option carries a second encoded stream from start to end, sound or no
sound. While the sound plays, each 50 ms frame is a copy of a buffer that
already has the volume applied.

**Pipecat.** There is no second stream. While the sound is off the injector
sends no background frames; it wakes for relevant audio events, delay expiry,
or checks for a transfer or handover tone ending. While it plays, the sound
goes out on the agent's existing output stream: in the gaps as extra audio
frames, and under the agent's speech by adding it to the speech frames.

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
