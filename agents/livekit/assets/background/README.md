# Background sound

`office-16k.wav` is the sound played by `options.backgroundAudio`. See
[docs/background-audio.md](../../../../docs/background-audio.md).

- Source: `resources/office-ambience.ogg` from
  [`@livekit/agents`](https://github.com/livekit/agents-js) 1.9.0, which is
  licensed Apache-2.0. The package's `resources/NOTICE` credits the two
  keyboard clips but not this one, so no further attribution is recorded
  upstream.
- Format: mono, 16 kHz, 16-bit PCM WAV, 21.5 s, mean level -20 dBFS, peak
  -2.1 dBFS. The low, medium and high volume levels in the worker are gains
  against that mean level.
- The loop seam carries a 0.5 s crossfade, so the sound can play for minutes
  without a click at the wrap.

To rebuild it, from the repository root after
`(cd agents/livekit && yarn install)`:

```shell
scripts/make-background-audio.sh
```

That script writes this file and the Pipecat worker's copy
(`agents/pipecat/pipecat_aplisay/assets/background/office-16k.wav`). Both
images build from the repository root but copy only their own worker
directory, which is why there are two copies.
`tests/background-audio-options.test.mjs` fails if they differ.
