#!/usr/bin/env bash
#
# Rebuild the committed background sound (options.backgroundAudio) from the clip
# bundled with @livekit/agents. See docs/background-audio.md.
#
#   scripts/make-background-audio.sh [source.ogg]
#
# Output: mono 16 kHz 16-bit PCM WAV, mean level -20 dBFS, with a crossfaded
# loop seam, written to both workers. The two copies must stay identical:
# tests/background-audio-options.test.mjs fails if they differ.
#
# Run it from the repository root, after `(cd agents/livekit && yarn install)`.
# Needs ffmpeg and ffprobe, found on PATH. Set FFMPEG to use another ffmpeg;
# ffprobe is then looked for beside it unless FFPROBE is set too.

set -euo pipefail

FFMPEG=${FFMPEG:-ffmpeg}
FFPROBE=${FFPROBE:-${FFMPEG%ffmpeg}ffprobe}
SRC=${1:-agents/livekit/node_modules/@livekit/agents/resources/office-ambience.ogg}

# Levels are RMS targets: the workers' low/medium/high gains are chosen against
# this mean level, so changing it changes how loud every agent's sound is.
TARGET_RMS_DBFS=-20
# Overlap at the loop seam. The sound plays for minutes in `always` mode, so a
# click at the wrap would be heard repeatedly.
CROSSFADE_SECS=0.5
RATE=16000

DESTS=(
  agents/livekit/assets/background/office-16k.wav
  agents/pipecat/pipecat_aplisay/assets/background/office-16k.wav
)

for tool in "$FFMPEG" "$FFPROBE"; do
  command -v "$tool" >/dev/null || { echo "not found: $tool" >&2; exit 1; }
done
[ -f "$SRC" ] || { echo "source clip not found: $SRC" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Mean level in dBFS, as `volumedetect` measures it.
mean_volume() {
  "$FFMPEG" -hide_banner -nostats -i "$1" -map 0:a -filter:a volumedetect -f null - 2>&1 \
    | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB.*/\1/p' | tail -1
}

peak_volume() {
  "$FFMPEG" -hide_banner -nostats -i "$1" -map 0:a -filter:a volumedetect -f null - 2>&1 \
    | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB.*/\1/p' | tail -1
}

# 1. Downmix and resample. The intermediates stay 32-bit float: the source is
#    quiet (about -55 dBFS mean), so the gain in step 3 is large and would lift
#    16-bit quantisation noise with it.
"$FFMPEG" -hide_banner -loglevel error -y -i "$SRC" \
  -ac 1 -ar "$RATE" -c:a pcm_f32le "$work/mono.wav"

duration=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$work/mono.wav")
body=$(awk -v d="$duration" -v c="$CROSSFADE_SECS" 'BEGIN { printf "%.6f", d - c }')
awk -v b="$body" 'BEGIN { exit (b > 1) ? 0 : 1 }' \
  || { echo "clip is too short to crossfade: ${duration}s" >&2; exit 1; }

# 2. Crossfade the end of the clip over its start, so the output loops without a
#    click: the first CROSSFADE_SECS is the blend of the clip's tail and head,
#    and the output ends where that tail began.
"$FFMPEG" -hide_banner -loglevel error -y \
  -ss "$body" -i "$work/mono.wav" \
  -t "$body" -i "$work/mono.wav" \
  -filter_complex "[0:a][1:a]acrossfade=d=${CROSSFADE_SECS}:c1=tri:c2=tri[out]" \
  -map "[out]" -ac 1 -ar "$RATE" -c:a pcm_f32le "$work/looped.wav"

# 3. Set the mean level. One measurement, one gain: no compression or limiting,
#    so the clip keeps its own dynamics.
measured=$(mean_volume "$work/looped.wav")
[ -n "$measured" ] || { echo "could not measure the mean level" >&2; exit 1; }
gain=$(awk -v t="$TARGET_RMS_DBFS" -v m="$measured" 'BEGIN { printf "%.3f", t - m }')
"$FFMPEG" -hide_banner -loglevel error -y -i "$work/looped.wav" \
  -filter:a "volume=${gain}dB" -ac 1 -ar "$RATE" -c:a pcm_s16le "$work/office-16k.wav"

# 4. Confirm the result: the level we asked for, and clear of full scale. A gain
#    applied to 16-bit PCM clips silently, so this is checked rather than assumed.
final_mean=$(mean_volume "$work/office-16k.wav")
final_peak=$(peak_volume "$work/office-16k.wav")
echo "source:     $SRC"
echo "duration:   ${duration}s in, ${body}s out (${CROSSFADE_SECS}s seam)"
echo "gain:       ${gain} dB (mean ${measured} dBFS -> ${final_mean} dBFS)"
echo "peak:       ${final_peak} dBFS"
awk -v p="$final_peak" 'BEGIN { exit (p < -0.5) ? 0 : 1 }' \
  || { echo "peak is too close to full scale; lower TARGET_RMS_DBFS" >&2; exit 1; }
awk -v m="$final_mean" -v t="$TARGET_RMS_DBFS" \
  'BEGIN { exit ((m - t) < 0.3 && (t - m) < 0.3) ? 0 : 1 }' \
  || { echo "mean level missed the target by more than 0.3 dB" >&2; exit 1; }

for dest in "${DESTS[@]}"; do
  mkdir -p "$(dirname "$dest")"
  cp "$work/office-16k.wav" "$dest"
  echo "wrote:      $dest"
done

echo
echo "Listen to the loop before committing:"
echo "  ffplay -loop 0 ${DESTS[0]}"
