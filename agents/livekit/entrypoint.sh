#!/bin/sh
#
# entrypoint.sh — the livekit-agent image's ENTRYPOINT.
#
# Loads SECRETENV_KEY / SECRETENV_BUNDLE from Google Secret Manager straight
# into the environment and then execs the agent, so the secrets exist only in
# the running process: nothing is written to any filesystem and nothing needs
# to sit in instance metadata or a mounted env file. Same shape as
# aplisay-sbc/entrypoint.sh (`eval $(node env-processor.js)`).
#
# load-secretenv.js also writes out the Google service-account JSON that ADC
# needs on disk, from the bundle it just decrypted — the runtime replacement
# for baking that key into an image layer at build time.
#
# `exec` matters: the agent becomes PID 1, so docker's SIGTERM reaches it
# directly and @livekit/agents drains in-flight calls (ServerOptions sets
# production: true) within the deployment's stop_grace_period. A wrapper left
# in between would swallow the signal and kill live calls on every upgrade.
#
# Env:
#   GOOGLE_SECRETENV_PATH   projects/<numeric>/secrets/<BASE>. A container
#                           handed SECRETENV_KEY + SECRETENV_BUNDLE directly
#                           (local development, CI) needs neither this nor
#                           Secret Manager access, and still gets its
#                           credential file written.
#
# Arguments are passed through to the agent, so the image's CMD (["start"]) and
# any override (`docker run … dev`) work as before.

set -eu

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${GOOGLE_SECRETENV_PATH:-}" ] || { [ -n "${SECRETENV_KEY:-}" ] && [ -n "${SECRETENV_BUNDLE:-}" ]; }; then
    # Fatal on purpose: without the bundle the agent would come up with no
    # LiveKit/Postgres/provider credentials and register as a broken worker.
    # Crash-looping with this message in `docker logs` is the safer failure.
    if ! SECRETENV_EXPORTS="$(node "$APP_DIR/load-secretenv.js")"; then
        echo "entrypoint: could not load the secretenv pair — refusing to start" >&2
        exit 1
    fi
    eval "$SECRETENV_EXPORTS"
    unset SECRETENV_EXPORTS
else
    echo "entrypoint: no GOOGLE_SECRETENV_PATH and no SECRETENV_* in the environment" >&2
    echo "entrypoint: starting anyway — the agent will run without decrypted secrets" >&2
fi

exec node "$APP_DIR/dist/realtime.js" "$@"
