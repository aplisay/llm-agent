#!/usr/bin/env bash
set -euo pipefail

# Clone agents-js v1.0.3 into temp-livekit-agents, build, and link locally

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
TEMP_DIR="$ROOT_DIR/temp-livekit-agents"

echo "Working directory: $ROOT_DIR"

if [ -d "$TEMP_DIR/.git" ]; then
  echo "Existing checkout detected at $TEMP_DIR"
else
  echo "Cloning livekit/agents-js into $TEMP_DIR"
  rm -rf "$TEMP_DIR"
  git clone --depth 1 --branch v1.0.3 https://github.com/livekit/agents-js "$TEMP_DIR"
fi

cd "$TEMP_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PKG_MGR=pnpm
else
  echo "pnpm is required. Install via: npm i -g pnpm"
  exit 1
fi

echo "Installing and building agents-js monorepo with $PKG_MGR"
$PKG_MGR install --frozen-lockfile || $PKG_MGR install
$PKG_MGR -r build || $PKG_MGR build

echo "Linking packages for local development"
$PKG_MGR -r link --global

cd "$ROOT_DIR"

if command -v yarn >/dev/null 2>&1; then
  echo "Linking @livekit packages into local project using yarn"
  yarn link "@livekit/agents"
  yarn link "@livekit/agents-plugin-google"
  yarn link "@livekit/agents-plugin-openai"
else
  echo "Yarn not found; attempting pnpm link local"
  pnpm link -g "@livekit/agents" || true
  pnpm link -g "@livekit/agents-plugin-google" || true
  pnpm link -g "@livekit/agents-plugin-openai" || true
fi

echo "Done. Ensure your dependency versions in package.json are compatible with v1.0.3."


