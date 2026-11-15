#!/bin/sh
# preStop hook: hold the pod while voiceblender has calls, for at most
# ENGINE_DRAIN_SECONDS. SIGTERM makes voiceblender hang every call up at once.
# The hook cannot stop new calls arriving: voiceblender has no drain mode.
set -u
bb=/etc/node-meta/busybox

limit="${ENGINE_DRAIN_SECONDS:-1200}"
url="http://${HOST_IP}:${ENGINE_API_PORT:-8080}/v1/legs"

# To the pod's log, which a hook's own output does not reach.
say() {
  echo "preStop: $*" > /proc/1/fd/1 2>/dev/null || true
}

# The leg list, not the active legs gauge: the gauge follows events, and
# voiceblender can drop a leg without one.
idle() {
  body="$("$bb" wget -q -T 3 -O - "$url" 2>/dev/null)" || return 2
  [ "$(printf '%s' "$body" | "$bb" tr -d '[:space:]')" = "[]" ]
}

waited=0
say "holding the pod for up to ${limit}s while voiceblender has calls"
while [ "$waited" -lt "$limit" ]; do
  idle
  case $? in
    0)
      say "no calls after ${waited}s: stopping"
      exit 0
      ;;
    2)
      # Not known to be idle, so keep holding: a wrong guess cuts calls.
      [ $((waited % 60)) -eq 0 ] && say "cannot read $url: still holding"
      ;;
    *)
      [ $((waited % 60)) -eq 0 ] && say "calls still up after ${waited}s"
      ;;
  esac
  "$bb" sleep 2
  waited=$((waited + 2))
done
say "calls still up after ${limit}s: stopping anyway, they will be cut"
exit 0
