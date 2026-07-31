#!/usr/bin/env bash
# Show container status on every node from the last deployment.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

run_on_each "cd ~/$REMOTE_DIR && docker compose ps && docker image inspect --format '{{index .RepoTags 0}} {{.Id}}' \$(docker compose images -q) 2>/dev/null | head -1"
