#!/usr/bin/env bash
# Pull the current image tag and restart, without touching any file on the VM.
# This is the normal post-release action: cloudbuild-release moves :latest,
# this rolls the runners onto it. The restart also makes each container re-read
# the secretenv pair from Secret Manager, so a rotated bundle lands too.
#
# Nodes are restarted one at a time. Each container gets the compose
# stop_grace_period (300s) to drain in-flight calls before it is replaced, so a
# multi-node run takes a while — that is deliberate.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

run_on_each "cd ~/$REMOTE_DIR \
    && (gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin https://$IMAGE_REGISTRY) \
    && docker compose pull \
    && docker compose up -d --force-recreate \
    && docker compose ps"
