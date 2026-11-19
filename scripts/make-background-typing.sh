#!/usr/bin/env bash
#
# Build the typing sound for options.backgroundAudio (`sound: typing`) from
# "Keyboard Soundpack #1" by Unicae Games (CC0). See docs/background-audio.md.
#
#   scripts/make-background-typing.sh <extracted pack directory>
#
# Get the pack from
# https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes
# (unicae_games_keyboard_soundpack_1_0.zip, SHA-256
# 935eae2fa5c3742eacdd38c4ea0e9047f3887faa0701996498492c256db1b351) and unzip it.
#
# Output: mono 16 kHz 16-bit PCM WAV, peak -1 dBFS, written to both workers.
# The two copies must stay identical: tests/background-audio-options.test.mjs
# fails if they differ.
#
# Needs ffmpeg and ffprobe, found on PATH. Set FFMPEG to use another ffmpeg;
# ffprobe is then looked for beside it unless FFPROBE is set too.

set -euo pipefail

FFMPEG=${FFMPEG:-ffmpeg}
FFPROBE=${FFPROBE:-${FFMPEG%ffmpeg}ffprobe}
PACK=${1:?usage: $0 <extracted pack directory>}

# Typing is short clicks with silence between them, so its mean level says
# little about how loud it sounds. Set the peak instead. The office sound is set
# by its mean level (make-background-audio.sh), so at the same volume setting
# the typing has a lower mean level.
TARGET_PEAK_DBFS=-1
RATE=16000
FADE_SECS=0.008

DESTS=(
  agents/livekit/assets/background/typing-16k.wav
  agents/pipecat/pipecat_aplisay/assets/background/typing-16k.wav
)

# Bursts of typing from the three softest human takes, each cut in a pause
# between keystrokes, then the silence that follows it. The loop ends on
# silence and starts on typing, so the seam needs no crossfade. Pauses stay
# short: the sound often plays for only a few seconds.
#   take          start  end   pause after (s)
SEGMENTS=(
  "human_vel-001 0.15 2.40 0.6"
  "human_vel-002 0.00 1.37 0.9"
  "human_vel-003 0.90 3.94 0.5"
  "human_vel-001 3.15 4.68 1.1"
  "human_vel-002 1.37 4.85 0.7"
  "human_vel-003 4.78 5.93 0.4"
  "human_vel-001 4.68 7.68 1.2"
  "human_vel-002 4.85 6.22 0.8"
)

for tool in "$FFMPEG" "$FFPROBE"; do
  command -v "$tool" >/dev/null || { echo "not found: $tool" >&2; exit 1; }
done
[ -d "$PACK/Human Typing" ] || { echo "not the extracted pack: $PACK" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

volumedetect() {
  "$FFMPEG" -hide_banner -nostats -i "$1" -map 0:a -filter:a volumedetect -f null - 2>&1 \
    | sed -n "s/.*$2: \(-*[0-9.]*\) dB.*/\1/p" | tail -1
}

# 1. Cut each burst, fade its ends, pad the pause after it, and join them. The
#    intermediate stays 32-bit float and at the source rate until step 2.
inputs=()
filters=""
labels=""
i=0
for seg in "${SEGMENTS[@]}"; do
  read -r take start end pause <<<"$seg"
  dur=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.3f", e - s }')
  fade_out=$(awk -v d="$dur" -v f="$FADE_SECS" 'BEGIN { printf "%.3f", d - f }')
  inputs+=(-ss "$start" -t "$dur" -i "$PACK/Human Typing/$take.wav")
  filters+="[$i:a]aformat=sample_fmts=flt,afade=t=in:d=$FADE_SECS,afade=t=out:st=$fade_out:d=$FADE_SECS,apad=pad_dur=$pause[s$i];"
  labels+="[s$i]"
  i=$((i + 1))
done
"$FFMPEG" -hide_banner -loglevel error -y "${inputs[@]}" \
  -filter_complex "${filters}${labels}concat=n=$i:v=0:a=1[out]" \
  -map "[out]" -ac 1 -c:a pcm_f32le "$work/joined.wav"

# 2. Resample, then set the peak. One gain, no limiting, so the clicks keep
#    their shape.
"$FFMPEG" -hide_banner -loglevel error -y -i "$work/joined.wav" \
  -af "aresample=$RATE:resampler=soxr" -ac 1 -c:a pcm_f32le "$work/resampled.wav"
measured=$(volumedetect "$work/resampled.wav" max_volume)
[ -n "$measured" ] || { echo "could not measure the peak" >&2; exit 1; }
gain=$(awk -v t="$TARGET_PEAK_DBFS" -v m="$measured" 'BEGIN { printf "%.3f", t - m }')
"$FFMPEG" -hide_banner -loglevel error -y -i "$work/resampled.wav" \
  -filter:a "volume=${gain}dB" -ac 1 -ar "$RATE" -c:a pcm_s16le "$work/typing-16k.wav"

# 3. Confirm the result.
duration=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$work/typing-16k.wav")
final_peak=$(volumedetect "$work/typing-16k.wav" max_volume)
final_mean=$(volumedetect "$work/typing-16k.wav" mean_volume)
echo "pack:       $PACK"
echo "duration:   ${duration}s from ${#SEGMENTS[@]} bursts"
echo "gain:       ${gain} dB (peak ${measured} dBFS -> ${final_peak} dBFS)"
echo "mean:       ${final_mean} dBFS"
awk -v p="$final_peak" -v t="$TARGET_PEAK_DBFS" \
  'BEGIN { exit ((p - t) < 0.3 && (t - p) < 0.3) ? 0 : 1 }' \
  || { echo "peak missed the target by more than 0.3 dB" >&2; exit 1; }

for dest in "${DESTS[@]}"; do
  mkdir -p "$(dirname "$dest")"
  cp "$work/typing-16k.wav" "$dest"
  echo "wrote:      $dest"
done

echo
echo "Listen to the loop before committing:"
echo "  ffplay -loop 0 ${DESTS[0]}"
