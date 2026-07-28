# CONTEXT.md — agent onboarding for `llm-agent`

> **STATUS: STARTER / PROVISIONAL.** This file was scaffolded as part of the ship-kit
> install and captures the structure that is observable from the tree. The sections marked
> **TODO(domain)** need a pass from someone who knows the system *before the first real
> `/ship` run*, because the parallel agents and reviewers rely on this file being correct.
> In particular: confirm the Definition of Done (§4), conventions (§10), and hot files (§11).

You are editing **llm-agent**, Aplisay's voice-agent orchestration backend: an HTTP/WebSocket
API that provisions and drives conversational voice agents across multiple gateways
(LiveKit, Pipecat, Jambonz) and LLM providers. Read this fully before touching code.

## 1. What this project is

A Node/Express service (`index.mjs`) exposing an OpenAPI-described REST API plus a WebSocket
channel, backed by a database, that creates agents, places/receives calls, streams
transcripts, handles transfers/recording, and meters usage. Gateway-specific agent code
lives under `agents/`.

## 2. Tech stack (versions that matter)

- **Node + ES modules** (`.mjs`/`.js`, `"type": "module"`-style imports).
- **Express** + **express-openapi** driven by `api/api-doc.yaml` (+ `api/paths/*`).
- **yarn** at the repo root. **`agents/livekit`** is **TypeScript built with tsup**
  (`dist/`) and has its **own lockfile** (pnpm) — it is effectively a sub-project.
- **Jest** tests, split into DB-backed and no-DB configs; DB tests use **docker-compose**.
- TODO(domain): pin the Node version and any other version that changes commands.

## 3. Getting started

```bash
yarn install
# agents/livekit is a separate build (TypeScript → dist via tsup):
cd agents/livekit && yarn build && cd -
yarn develop            # NODE_ENV=development … nodemon index.mjs
```
TODO(domain): document required env (`environment-example`) and any service deps.

## 4. How to verify a change (the Definition of Done)

**Current gate (provisional): the `agents/livekit` build must pass** —
`cd agents/livekit && yarn build`. This catches the `lib → agents/livekit/dist` layering
class of breakage (see issue #123) at low cost. It matches `verify` in
`.claude/ship.config.json`.

TODO(domain): decide the real gate. Candidates to add once validated in a worktree:
- `yarn test:no-db` (jest, no database) — fast, no docker.
- the full `yarn test:db` (needs docker/DB via `tests/docker-compose.test.yml`) — heavier;
  likely too slow/fragile to run per-PR in parallel worktrees without tuning.
The gate must be runnable on an isolated worktree with only `yarn install` + the livekit
build available. Keep it deterministic.

## 5. Architecture & where things live

- `index.mjs` — server entry: Express + express-openapi (`api/api-doc.yaml`), HTTP server,
  WebSocket server (`lib/ws-handler.js`), handler cleanup (`lib/handlers/index.js`).
- `api/` — `api-doc.yaml` (the OpenAPI surface) + `paths/` (operation handlers).
- `lib/` — the core services:
  - `models/*` — LLM/gateway adapters: `anthropic, openai, gemini, google-vertexai,
    ultravox, livekit, pipecat` + `index.js`, `llm.js`.
  - `database.js`, `database-models/*` — persistence.
  - `handlers/`, `ws-handler.js` — request/WebSocket lifecycle.
  - `agent-set-service.js`, `agent-set-labels.js`, `set-builder-agent.js`, `subagent.js`,
    `builtin-agents.js` — agent-set / multi-agent features.
  - `voices/*`, `model-voices.js` — voice catalogue.
  - `auth/*`, `scope.js`, `admin-gate.js` — auth & RBAC.
  - `usage.js` — usage metering (billing pipeline).
  - `recording/`, `call-hook.js`, `jambonz.js`, `concurrency/`, `schemas/`, `utils/`.
- `agents/` — `livekit` (TS/tsup), `pipecat`, `jambonz`: the per-gateway agent runtimes.
- `middleware/`, `tools/`, `scripts/`, `data/`, `deploy/`.
- `docs/*.md` — extensive design docs (architecture, recording, transfers, MCP, etc.).

## 6. API surface

`api/api-doc.yaml` is the contract; operations resolve to `api/paths/*`. Any change to the
public API MUST update `api/api-doc.yaml` — it is a hot/shared file.

## 7. Data flow, services & boundaries

Calls flow API/WS → a gateway agent (`agents/*`) → an LLM provider (`lib/models/*`).
**Layering caution:** `lib/models/livekit.js` imports the LiveKit agent's compiled `dist`
(issue #123) — a declared TypeScript type at that boundary is **not** runtime-safe; a
reviewer must treat that class of defect as blocking.
TODO(domain): document the auth model and the DB/service boundaries.

## 8. (n/a) UI
This is a backend service — no UI.

## 9. Persistence / external systems

A database (see `lib/database.js`, `lib/database-models/*`); external gateways (LiveKit,
Pipecat, Jambonz) and LLM providers. DB tests run against docker-compose.
TODO(domain): name the DB engine, migrations, and required external creds.

## 10. Conventions, gotchas & non-negotiables

TODO(domain): the rules a reviewer enforces. Seeds:
- Keep the public API (`api/api-doc.yaml`) and its `api/paths/*` handlers in sync.
- Respect the `lib → agents/*/dist` layering (don't deepen the inversion of issue #123).
- ES-module import style; match existing logging (`lib/logger.js`).

## 11. Working in parallel (coordination)

**High-contention shared files** (edits force sequential merges — match `hotFiles` in
`.claude/ship.config.json`):
`index.mjs`, `api/api-doc.yaml`, `lib/ws-handler.js`, `lib/handlers/index.js`,
`lib/database.js`, `lib/models/index.js`, `package.json`.
TODO(domain): confirm/extend this list from real merge experience.

## 12. Quick file index

| Touching… | Look at… |
|---|---|
| The API surface | `api/api-doc.yaml` → `api/paths/*` |
| Server/WS wiring | `index.mjs`, `lib/ws-handler.js`, `lib/handlers/*` |
| An LLM/gateway adapter | `lib/models/*` |
| A gateway runtime | `agents/{livekit,pipecat,jambonz}` |
| Persistence | `lib/database.js`, `lib/database-models/*` |
| Voices | `lib/voices/*`, `lib/model-voices.js` |
| Auth / RBAC | `lib/auth/*`, `lib/scope.js`, `lib/admin-gate.js` |
| Usage / billing | `lib/usage.js` |
