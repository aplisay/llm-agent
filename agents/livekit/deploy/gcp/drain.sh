#!/usr/bin/env bash
# Drain a runner's worker before its container — or its VM — is stopped.
#
# Why this exists: upgrade.sh replaces a container in place and gets a clean
# drain for free, because compose sends SIGTERM and waits out
# stop_grace_period. Nothing gives you that when you retire a whole node. The
# deploy scripts bring a new runner UP but never take the old one DOWN, so the
# last step of a host migration is someone stopping the old VM by hand — and a
# VM stop does not drain anything. dockerd kills containers after its own
# --shutdown-timeout (15s by default), not the container's 300s grace, and if
# the guest is powered off harder than that the registration WebSocket is never
# closed at all: the TCP session simply goes dead.
#
# That matters because LiveKit Cloud can go on offering jobs to a worker that
# no longer exists until its own keepalive expires. A job offered to a corpse
# is never accepted, and an inbound SIP leg waiting on that agent just rings.
# On 2026-07-31 two staging test-agent runs (dtmf:Windsor->Wildix) failed
# exactly that way — the return leg reached the b2bua in 1.4s, LiveKit rang it
# for 29s, our live worker was idle and was never offered the job, and the
# A-leg hit its 30s cap and cancelled. The previous runners had been
# hard-stopped nine minutes earlier.
#
# @livekit/agents already does the right thing on SIGTERM: realtime.ts sets
# `production: true`, so cli.js calls Worker.drain(), which flips the worker to
# WS_FULL (LiveKit stops dispatching to it), waits for in-flight jobs to
# finish, and then closes the WebSocket. All this script does is make sure that
# signal is delivered and that we WAIT for the process to exit before anything
# stops the machine underneath it.
#
# Usage:
#   NODES=agent-runner-staging:europe-west2-b ./drain.sh
#   NODES=... DOWN=1 ./drain.sh             # also remove the container
#   NODES=... STOP_VM=1 ./drain.sh          # ...and stop the VM afterwards
#   NODES=... DRAIN_TIMEOUT=600 ./drain.sh  # default 300s, matches compose
#
# STOP_VM implies DOWN: `restart: always` would otherwise bring the worker back
# — and re-register it — the moment anyone starts that VM again to look at it.
#
# A container exit code of 137 means the drain did NOT finish inside
# DRAIN_TIMEOUT and the process was killed. That is precisely the
# zombie-registration case, so the VM is left running unless you pass FORCE=1.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-300}"
DOWN="${DOWN:-0}"
STOP_VM="${STOP_VM:-0}"
FORCE="${FORCE:-0}"

# Retiring the machine means the container must not be able to come back on its
# own the next time someone starts it. Spelled out rather than `[ … ] && DOWN=1`
# so errexit semantics are not part of the reasoning.
if [ "$STOP_VM" = "1" ]; then
    DOWN=1
fi

# Always `stop` first, even when we are going on to `down`. Stopping leaves the
# container in place so its exit code can be read, and that code is the only
# evidence we get that the drain actually completed rather than being
# SIGKILLed. `down` would remove the container and take that evidence with it.
if [ "$DOWN" = "1" ]; then
    REMOVE_AFTER="docker compose down --timeout 10"
else
    REMOVE_AFTER="true"
fi

# The worker's health server is bound inside the container on 8081 and is
# deliberately not published, so ask the container itself. `/worker` is the
# SDK's worker-info route and carries active_jobs; `/` is only a health string.
# Single quotes inside the -e program, escaped double quotes around it — the
# whole thing arrives at the node as one argv entry.
WORKER_INFO="docker exec livekit-agent node -e \"fetch('http://127.0.0.1:8081/worker').then(r=>r.text()).then(console.log)\" 2>/dev/null || echo '{\"active_jobs\":\"unknown\"}'"

failed=0

for i in "${!NODE_NAMES[@]}"; do
    node="${NODE_NAMES[$i]}"
    zone="${NODE_ZONES[$i]}"
    echo "=== $node ($zone) ==="

    # Everything up to and including the wait happens in one SSH session, so a
    # dropped connection cannot leave us believing a drain finished when it did
    # not. `compose stop/down -t N` sends SIGTERM and blocks for up to N
    # seconds; the exit code we read afterwards is the real verdict.
    if ! gcloud compute ssh "$node" --zone="$zone" --project="$PROJECT_ID" --command="
        set -eu
        cd ~/$REMOTE_DIR
        echo -n 'worker before drain: '
        $WORKER_INFO
        started=\$(date +%s)
        echo \"sending SIGTERM, waiting up to ${DRAIN_TIMEOUT}s for in-flight calls...\"
        docker compose stop --timeout $DRAIN_TIMEOUT
        elapsed=\$(( \$(date +%s) - started ))
        code=\$(docker inspect livekit-agent --format '{{.State.ExitCode}}' 2>/dev/null || echo unknown)
        echo \"drained in \${elapsed}s, container exit code: \$code\"
        if [ \"\$code\" = '137' ]; then
            echo 'WARNING: SIGKILLed — drain did not complete, registration may be stale'
            exit 3
        fi
        $REMOVE_AFTER
        exit 0
    "; then
        echo "!! $node did not drain cleanly" >&2
        failed=1
        if [ "$FORCE" != "1" ]; then
            echo "!! leaving $node running; re-run with FORCE=1 to stop it anyway" >&2
            continue
        fi
    fi

    if [ "$STOP_VM" = "1" ]; then
        echo "stopping VM $node ..."
        gcloud compute instances stop "$node" --zone="$zone" --project="$PROJECT_ID"
    fi
done

exit "$failed"
