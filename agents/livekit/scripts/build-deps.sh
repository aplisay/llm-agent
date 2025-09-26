#!/usr/bin/env bash
set -euo pipefail

# Build agents-js submodule and link it locally using Yarn link: protocol

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
SUBMODULE_DIR="$ROOT_DIR/temp-livekit-agents"

if [ ! -d "$SUBMODULE_DIR" ]; then
  echo "Submodule not found at $SUBMODULE_DIR. Ensure git submodules are initialized (git submodule update --init --recursive)." >&2
  exit 1
fi

echo "Building agents-js in $SUBMODULE_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install via: npm i -g pnpm" >&2
  exit 1
fi

pnpm -C "$SUBMODULE_DIR" install --frozen-lockfile || pnpm -C "$SUBMODULE_DIR" install
pnpm -C "$SUBMODULE_DIR" -r build || pnpm -C "$SUBMODULE_DIR" build

echo "Linking packages into local project with Yarn link: protocol"
cd "$ROOT_DIR"

if ! command -v yarn >/dev/null 2>&1; then
  echo "yarn (classic) is required to add link: dependencies." >&2
  exit 1
fi

yarn add -W "@livekit/agents@link:temp-livekit-agents/agents" \
             "@livekit/agents-plugin-google@link:temp-livekit-agents/plugins/google" \
             "@livekit/agents-plugin-openai@link:temp-livekit-agents/plugins/openai"

echo "Dependencies linked locally."


