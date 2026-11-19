# Background sounds

The sounds played by `options.backgroundAudio`. See
[docs/background-audio.md](../../../../../docs/background-audio.md).

Both images build from the repository root but copy only their own worker
directory, which is why the LiveKit worker has a copy of each file
(`agents/livekit/assets/background/`).
`tests/background-audio-options.test.mjs` fails if the copies differ.

## `office-16k.wav`

- Source: `resources/office-ambience.ogg` from
  [`@livekit/agents`](https://github.com/livekit/agents-js) 1.9.0, which is
  licensed Apache-2.0. A copy of that licence is in
  `LICENCE-Apache-2.0.txt` beside this file. The package's `resources/NOTICE`
  credits the two keyboard clips but not this one, so no further attribution
  is recorded upstream.
- Changes from the source: downmixed to mono, resampled to 16 kHz, gain set
  for a -20 dBFS mean level, and a 0.5 s crossfade at the loop seam.
- Format: mono, 16 kHz, 16-bit PCM WAV, 21.5 s, mean level -20 dBFS, peak
  -2.1 dBFS. The low, medium and high volume levels in the worker are gains
  against that mean level. The worker resamples it once per process to the
  transport's own rate.

To rebuild it, from the repository root after
`(cd agents/livekit && yarn install)`, with `ffmpeg` and `ffprobe` installed
and on `PATH` (or set `FFMPEG` to the `ffmpeg` binary):

```shell
scripts/make-background-audio.sh
```

## `typing-16k.wav`

- Source: "Keyboard Soundpack #1 [Typing and Single Keystrokes]" by Unicae
  Games, from
  <https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes>,
  submitted 12 February 2021. Licence: CC0 1.0 (public domain dedication), as
  shown on that page. The pack's readme says "Free to use however you like".
  The author states it was recorded on a Cherry KC 1000 keyboard with a Shure
  SM7B microphone. Downloaded on 16 November 2026 as
  `unicae_games_keyboard_soundpack_1_0.zip`, SHA-256
  `935eae2fa5c3742eacdd38c4ea0e9047f3887faa0701996498492c256db1b351`.
- Changes from the source: eight bursts cut from `human_vel-001`, `-002` and
  `-003` in the pack's "Human Typing" folder, joined with pauses of 0.4 to
  1.2 s, resampled to 16 kHz, and gain set for a -1 dBFS peak. The cut points
  are listed in the script.
- Format: mono, 16 kHz, 16-bit PCM WAV, 23.4 s, peak -1 dBFS, mean level
  -32.5 dBFS (-28.8 LUFS). It is set by its peak, not its mean level, so at
  the same volume setting it is quieter than the office sound. The worker
  resamples it once per process to the transport's own rate.

To rebuild it, download and unzip the pack, then from the repository root:

```shell
scripts/make-background-typing.sh <extracted pack directory>
```
