#!/bin/sh
# Level 1 smoke test of the compose stack, with no provider key:
#   setup, docker compose up, health, first API key, create a text agent on
#   the stub model, one chat round trip over the WebSocket, tear down.
# The same script runs in CI (.github/workflows/smoke.yml).
#
#   scripts/smoke.sh               # build, test, tear down
#   SMOKE_KEEP=1 scripts/smoke.sh  # leave the stack running afterwards
#
# It uses the compose project "aplisay-smoke" and ports 4000, 7880-7882 and
# 8080, so stop any other stack on those ports first.
set -eu

cd "$(dirname "$0")/.."
PROJECT=${SMOKE_PROJECT:-aplisay-smoke}
API=http://localhost:${API_PORT:-4000}
compose() { docker compose -p "$PROJECT" "$@"; }

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'SMOKE FAILED: %s\n' "$*" >&2; exit 1; }

teardown() {
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "-- api log (last 60 lines)"
        compose logs --no-color --tail 60 api 2>/dev/null || true
    fi
    if [ "${SMOKE_KEEP:-}" != "1" ]; then
        step "Tear down"
        compose down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    exit "$status"
}
trap teardown EXIT

step "Setup"
sh scripts/compose-setup.sh >/dev/null
KEY=$(grep -E '^BOOTSTRAP_API_KEY=.' .env | tail -n 1 | cut -d= -f2-)
[ -n "$KEY" ] || fail "no BOOTSTRAP_API_KEY in .env"

step "docker compose up"
# The stub model is listed only with this set; compose passes it to the API.
APLISAY_STUB_MODEL=1 compose up -d --build --wait --wait-timeout 600

step "Health"
health=$(curl -fsS "$API/api/health") || fail "GET /api/health"
echo "$health" | grep -q '"status":"ok"' || fail "health status is not ok: $health"
echo "ok"

auth="Authorization: Bearer $KEY"
json="Content-Type: application/json"

step "First API key"
models=$(curl -fsS -H "$auth" "$API/api/models") || fail "GET /api/models with the bootstrap key"
echo "$models" | grep -q '"text:stub/echo"' || fail "text:stub/echo is not listed"
echo "the key works; text:stub/echo is listed"

step "Create an agent"
agent=$(curl -fsS -H "$auth" -H "$json" "$API/api/agents" \
    -d '{"name":"Smoke test","modelName":"text:stub/echo","prompt":"Repeat what the user says."}') \
    || fail "POST /api/agents"
agent_id=$(printf '%s' "$agent" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -n 1)
[ -n "$agent_id" ] || fail "no agent id in: $agent"
echo "agent $agent_id"

step "Text chat round trip"
chat=$(curl -fsS -H "$auth" -H "$json" -X POST "$API/api/agents/$agent_id/chat" -d '{}') \
    || fail "POST /api/agents/$agent_id/chat"
session=$(printf '%s' "$chat" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -n 1)
[ -n "$session" ] || fail "no session id in: $chat"
# The client runs in the api container, so the host needs no Node.
compose exec -T -e SESSION="$session" api node --input-type=module -e '
import WebSocket from "ws";
const ws = new WebSocket(`ws://localhost:4000/chat/${process.env.SESSION}`);
const timer = setTimeout(() => { console.error("no answer within 20 s"); process.exit(1); }, 20000);
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "error") { console.error("error:", msg); process.exit(1); }
  // The server builds the model driver after the socket opens and says
  // "attached" when it is ready; a message sent earlier finds no driver.
  if (msg.type === "attached") ws.send(JSON.stringify({ type: "user", text: "hello from the smoke test" }));
  // A new session may open with a hidden turn of its own; wait for our answer.
  if (msg.type === "agent") {
    console.log(`agent said: ${msg.text}`);
    if (msg.text !== "echo: hello from the smoke test") return;
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (err) => { console.error(err.message); process.exit(1); });
' || fail "chat round trip"

step "PASSED"
