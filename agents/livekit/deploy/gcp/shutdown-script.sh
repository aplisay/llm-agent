#!/bin/bash
# GCE shutdown script for the LiveKit agent runners: drain the worker before
# the network goes down. A plain VM stop never does (COS dockerd runs with
# live-restore), and LiveKit then offers jobs to the dead worker for ~15 min.
# See README.md "Stopping a runner". Install with install-shutdown-script.sh.

# systemd keeps the network up until this script returns. GCE allows a
# standard VM 120 s to shut down.
DRAIN_SECONDS=90

log() { echo "agent-shutdown: $*"; }

alive() {
    local pid
    for pid in $pids; do
        kill -0 "$pid" 2>/dev/null && return 0
    done
    return 1
}

# konlet runs `node dist/realtime.js start`; the compose entrypoint execs it by
# absolute path. Job processes have a different command line.
pids=$(pgrep -f '^node ([^ ]*/)?dist/realtime\.js start$')
if [ -z "$pids" ]; then
    log "no agent worker running"
    exit 0
fi

# docker stop, not a bare signal: it marks the container stopped by hand, so
# its restart: always policy does not start the worker again before power-off.
containers=$(docker ps -q --filter name=klt-agent-runner --filter name=livekit-agent 2>/dev/null)
if [ -n "$containers" ]; then
    log "docker stop -t $DRAIN_SECONDS $(echo $containers) (worker pid $(echo $pids))"
    docker stop -t "$DRAIN_SECONDS" $containers >/dev/null 2>&1 &
    sleep 1
fi

# Nothing orders docker.service after this unit, so dockerd may exit before it
# delivers the signal, and live-restore leaves the container running. Signal
# the worker directly too: a second SIGTERM is harmless.
kill -TERM $pids 2>/dev/null

started=$SECONDS
while alive; do
    if [ $((SECONDS - started)) -ge "$DRAIN_SECONDS" ]; then
        # SIGKILL while the network is still up, so the kernel closes the
        # LiveKit socket and the registration goes at once.
        log "worker still running after ${DRAIN_SECONDS}s; sending SIGKILL"
        kill -KILL $pids 2>/dev/null
        exit 0
    fi
    sleep 1
done
log "worker exited after $((SECONDS - started))s"
