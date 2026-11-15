#!/bin/bash
# Run the worker behind call control against a real voiceblender: a call in
# that call control hands over, and a call out. Needs Docker and uv.
#
#   integration/voiceblender-dispatch/run.sh          build, run, tear down
#   integration/voiceblender-dispatch/run.sh --keep   leave the engines up
#   VOICEBLENDER_COMMIT=<full commit id> integration/voiceblender-dispatch/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# The upstream commit the engine is built from.
export VOICEBLENDER_COMMIT="${VOICEBLENDER_COMMIT:-c3cfd41e5fac3c83d9cc9328981adcd63787a499}"
export RECORDINGS_DIR="${RECORDINGS_DIR:-$(mktemp -d)}"
chmod 0777 "$RECORDINGS_DIR"
compose=(docker compose -f "$here/compose.yml")
keep=0
if [ "${1:-}" = "--keep" ]; then keep=1; shift; fi

cleanup() {
  if [ "$keep" = "1" ]; then
    echo "run.sh: leaving the engines up (docker compose -f $here/compose.yml down -v removes them)"
    return
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" down --remove-orphans >/dev/null 2>&1 || true
echo "run.sh: voiceblender at $VOICEBLENDER_COMMIT"
"${compose[@]}" up -d --wait engine far

cd "$here/../.."
if uv run --frozen python integration/voiceblender-dispatch/calls.py "$@"; then
  echo "run.sh: PASS (voiceblender $VOICEBLENDER_COMMIT)"
else
  echo "run.sh: FAIL; the engine's log follows"
  "${compose[@]}" logs --no-color --tail=200 engine || true
  exit 1
fi
