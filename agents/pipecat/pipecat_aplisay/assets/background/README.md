# Background sound

`office-16k.wav` is the sound played by `options.backgroundAudio`. See
[docs/background-audio.md](../../../../../docs/background-audio.md).

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

That script writes this file and the LiveKit worker's copy
(`agents/livekit/assets/background/office-16k.wav`). Both images build from
the repository root but copy only their own worker directory, which is why
there are two copies. `tests/background-audio-options.test.mjs` fails if they
differ.
