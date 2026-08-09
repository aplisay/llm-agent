#!/usr/bin/env bash
# Tail the agent log.
#
# With one node in .last-deployment this follows it (-f). With several, it
# prints the last N lines from each in turn — following many SSH sessions at
# once is not useful. Pass a node explicitly to follow one of them:
#
#   NODES=agent-runner-production:europe-west1-d ./log.sh
#   LINES=500 ./log.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

LINES="${LINES:-200}"

if [ "${#NODE_NAMES[@]}" -eq 1 ]; then
    exec gcloud compute ssh "${NODE_NAMES[0]}" --zone="${NODE_ZONES[0]}" --project="$PROJECT_ID" \
        --command="cd ~/$REMOTE_DIR && docker compose logs -f --tail=$LINES"
fi

run_on_each "cd ~/$REMOTE_DIR && docker compose logs --tail=$LINES --no-color"
