#!/usr/bin/env bash
#
# Shared helpers for the small operational scripts (log.sh, status.sh,
# upgrade.sh). Sourced, not executed.
#
# Reads .last-deployment (written by deploy-node.sh) for the node list, default
# zone and environment, so the helpers need no arguments. Override any of them
# from the environment:
#
#   NODES=agent-runner-production:europe-west1-d ./log.sh
#   ENVIRONMENT=staging ./status.sh

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_DIR="livekit-agent"

if [ -f "$COMMON_DIR/.last-deployment" ]; then
    # shellcheck disable=SC1091
    . "$COMMON_DIR/.last-deployment"
fi

NODES="${NODES:-${LAST_NODES:-}}"
ZONE="${ZONE:-${LAST_ZONE:-europe-west1-d}}"
ENVIRONMENT="${ENVIRONMENT:-${LAST_ENVIRONMENT:-staging}}"

if [ -z "$NODES" ]; then
    echo "No nodes known. Run ./deploy-node.sh first, or set NODES=name[:zone][,…]" >&2
    exit 1
fi

ENV_FILE="$COMMON_DIR/.env.$ENVIRONMENT"
if [ -f "$ENV_FILE" ]; then
    PROJECT_ID="${PROJECT_ID:-$(grep '^PROJECT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)}"
    IMAGE_REGISTRY="${IMAGE_REGISTRY:-$(grep '^IMAGE_REGISTRY=' "$ENV_FILE" | head -1 | cut -d= -f2-)}"
fi
PROJECT_ID="${PROJECT_ID:-llm-voice}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-europe-west1-docker.pkg.dev}"

NODE_NAMES=()
NODE_ZONES=()
_oifs=$IFS
IFS=','
for _entry in $NODES; do
    _entry=$(printf '%s' "$_entry" | tr -d '[:space:]')
    [ -z "$_entry" ] && continue
    case "$_entry" in
        *:*) NODE_NAMES+=("${_entry%%:*}"); NODE_ZONES+=("${_entry#*:}") ;;
        *)   NODE_NAMES+=("$_entry");       NODE_ZONES+=("$ZONE") ;;
    esac
done
IFS=$_oifs

# run_on_each "<remote shell command>"
run_on_each() {
    local cmd="$1" i
    for i in "${!NODE_NAMES[@]}"; do
        echo "=== ${NODE_NAMES[$i]} (${NODE_ZONES[$i]}) ==="
        gcloud compute ssh "${NODE_NAMES[$i]}" --zone="${NODE_ZONES[$i]}" --project="$PROJECT_ID" \
            --command="$cmd"
    done
}
