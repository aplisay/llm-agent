#!/usr/bin/env bash
# Attach shutdown-script.sh to runner VMs as their GCE `shutdown-script`
# metadata, so any stop (by hand, by an instance schedule, or by GCE) drains
# the worker first. Works on konlet and compose runners. Adding metadata does
# not restart the VM; the script is read when the VM next shuts down.
#
# Usage:
#   NODES=agent-runner-production:europe-west1-d,agent-runner-production-be4:europe-west1-b ./install-shutdown-script.sh
#   NODES=... REMOVE=1 ./install-shutdown-script.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

SCRIPT="$COMMON_DIR/shutdown-script.sh"
REMOVE="${REMOVE:-0}"

for i in "${!NODE_NAMES[@]}"; do
    node="${NODE_NAMES[$i]}"
    zone="${NODE_ZONES[$i]}"
    if [ "$REMOVE" = "1" ]; then
        echo "=== $node ($zone): removing shutdown-script"
        gcloud compute instances remove-metadata "$node" --zone="$zone" --project="$PROJECT_ID" \
            --keys=shutdown-script
    else
        echo "=== $node ($zone): installing shutdown-script"
        gcloud compute instances add-metadata "$node" --zone="$zone" --project="$PROJECT_ID" \
            --metadata-from-file=shutdown-script="$SCRIPT"
    fi
done
