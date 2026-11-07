# Release 0.9.59 (draft) - GPT-Live on LiveKit

> Draft. Covers changes merged to `next` since the 0.9.58 release point. The
> version number is provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## ElevenLabs Agents on Pipecat - core+pipecat

- **[core+pipecat] `pipecat:elevenlabs/<llm>`**: ElevenLabs Agents runs on the
  Pipecat worker as four realtime rows, one per LLM (Gemini 2.5 Flash, GPT-5.4
  mini, Claude Haiku 5.5, Claude Sonnet 5.5). Functions, builtins and MCP
  tools run as client tools; the greeting text is spoken word for word; the
  voice is any ElevenLabs catalogue voice; billing is per minute on the call's
  voice row. `vendorSpecific.elevenlabs.conversation_config` tunes
  turn-taking and the TTS model. See [elevenlabs-agents.md](../elevenlabs-agents.md).
- **[core+livekit] `livekit:elevenlabs/<llm>`**: the same four rows on the
  LiveKit worker, sharing the hosted agents with the Pipecat rows.
- **[core] `scripts/add-elevenlabs-rate-lines.mjs`** seeds the minute lines;
  `scripts/prune-elevenlabs-agents.mjs` removes hosted agents no longer used.

## GPT-Live on LiveKit - core+livekit

- **[core+livekit] `livekit:openai/gpt-live-1`**: OpenAI GPT-Live now runs on
  the LiveKit worker, with the same `delegate` backend, voices, greeting and
  billing as the Pipecat row. It has no MCP tools, and keypad digits go to the
  voice model only. See [gpt-live.md](../gpt-live.md).
- **[livekit] Custom voices**: an organisation's custom voices
  ([custom-voices.md](../custom-voices.md)) work on the LiveKit row too. The
  same voice serves both rows, and its `models` now lists both.

## Gemini Live - core+livekit+pipecat

- **[core+livekit+pipecat] Gemini Live model**: the Gemini Live rows are now
  `google/gemini-2.5-flash-native-audio-preview-12-2025` ("Google Gemini 2.5
  Flash Live") on both workers. Google has shut down `gemini-2.0-flash-exp`, the
  model the rows were named after. Pipecat ran its library's default Live
  model, the one the rows now name, and LiveKit sent the retired id.
- **[core+livekit+pipecat] Retired Gemini id**: agents saved on
  `google/gemini-2.0-flash-exp` run the new model on both workers. The old id
  stays listed as a retired alias while the new row is offered. Pipecat records
  usage under the new id.
- **[pipecat] Gemini Live voice**: `options.tts.voice` now reaches the model.
  Every call spoke with Pipecat's default voice (Charon), which stays the
  default.
- **[pipecat] Gemini Live inactivity prompt**: `options.inactivity.message` is
  now spoken. The model never received it. It waits until the caller stops
  speaking.
- **[pipecat] Gemini Live keypad digits**: DTMF digits now reach the model as a
  user turn it answers. `options.dtmfTimeout` and `options.dtmfTerminator`
  apply as before.
- **[pipecat] Gemini Live transcript**: each caller turn is one `user`
  transcript row, with interim rows while the caller speaks, as on the other
  models. Each sentence was a row of its own.
- **[pipecat] Gemini Live handover**: `transfer_agent` between two agents on
  the same Gemini Live model now restarts the agent stack with a child call
  record, as for Ultravox, GPT-Live, Grok voice and ElevenLabs Agents. The
  in-place swap kept the outgoing agent's prompt and tools.

## Self-hosting - core

- **[core] `AUTHENTICATE_USERS=NO`**: removed. Every request now needs an API
  key. The setting is ignored, with a warning at start. In 0.9.58 it answered
  500 on every request.
- **[core] `yarn bootstrap`**: on a database with no users, creates one
  organisation, one `superAdmin` user and one API key, and prints the key.
  Options `--key`, `--org`, `--name` and `--email`. See
  [running.md](../running.md#first-api-key).
- **[core] `BOOTSTRAP_API_KEY`**: set it to a random value of 32 characters or
  more and the server does the same when it first starts, with that key. It is
  ignored once any user exists.
- **[core] Firebase sign-in**: `firebase-admin` loads on first use, so an
  instance that uses API keys alone needs neither the package nor Google
  credentials. On an instance with no Firebase project, an unknown token
  answers 401 `Authentication error: unknown API key or token`.
- **[core+livekit] Node version**: both `package.json` files declare Node 22
  LTS or 24 in `engines`, and `.nvmrc` names 22. `yarn install` refuses Node
  23 with a clear message.
- **[core] `yarn auth:migrate`** and `yarn auth:generate` fetch
  `@better-auth/cli` on demand, so a default install no longer builds
  `better-sqlite3`.
- **[core+livekit] LiveKit worker scripts**: `yarn livekit-dev` (repo root),
  and `yarn start`, `yarn stage` and `yarn develop` in `agents/livekit`, now
  start the worker. `yarn livekit-dev` reads the repo-root `.env`. A Linux
  checkout can now run the worker from source.
- **[core] Plain environment**: every image runs from plain environment
  variables; a `SECRETENV_KEY`/`SECRETENV_BUNDLE` pair is optional. See
  [running.md](../running.md#deploying), which now also gives each image's
  build command.
- **[core+livekit] `bundle-secretenv.sh`** uses the repo's installed secretenv,
  and its `npx` fallback is pinned to `v1.0.5`.
- **[core] Repository tidy**: removed `API.md` (stale generated JSDoc; the
  OpenAPI document `api/api-doc.yaml` is the reference), `agent.json`,
  `websocket-monitor.js` and the unused `uk-number-validator` submodule.
- **[core] Listen port**: the API server reads `PORT` when `WS_PORT` is unset,
  so it listens where Cloud Run, Kubernetes and most container platforms
  expect. `WS_PORT` still wins when both are set.
- **[core] API image start-up**: the image compiles the LiveKit model registry
  at build time, so a container no longer runs a TypeScript build on every
  start.
- **[core] `environment-example`**: rebuilt as a short template with every
  provider commented out and no placeholder strings. User sign-up and email are
  off; their settings moved to `environment-example.polite-ai`.
  `SERVICE_BASE_URI` now names port 4000.
- **[core] `config/env.schema.json`**: one entry per environment variable the
  API server, both voice workers and sipbridge read. `yarn env:generate` builds
  the templates and the new
  [configuration reference](../self-hosting/configuration.md) from it.
- **[core+livekit] Placeholder values**: a value written as `<...>` is treated
  as unset, with a warning at start.
- **[core] `yarn doctor`**: lists each runtime and provider as enabled or
  disabled, names what a disabled one is missing, and checks the database.
  The server logs the same table at start.
- **[core] `GET /api/health`**: needs no API key. Returns the same table as
  JSON, and 503 when the database does not answer. It names unset variables
  and never returns a value.
- **[core] Database settings**: the server exits with a message naming the
  missing `POSTGRES_*` variables instead of an `Invalid URL` error.
- **[core] Test page**: `tools/test-page` is a small page that talks to a
  LiveKit agent in the browser. It runs in the compose `ui` profile and is
  never served by the API server.
- **[core+livekit] `compose.yaml`**: `docker compose up` starts PostgreSQL,
  the API server, a LiveKit server, the LiveKit worker and the test page, with
  ports on 127.0.0.1. Optional `sip-livekit` and `edge` (Caddy) profiles. See
  [quickstart-local.md](../self-hosting/quickstart-local.md).
- **[core] `scripts/compose-setup.sh`** writes `.env` with random secrets and a
  first API key, and prints the key and the URLs.
- **[core] `SERVICE_BASE_URI`**: documented as the API server's base URL
  without `/api`, which is what the workers expect.

## Upgrade notes

- **[core] Gemini Live rate lines**: run `scripts/add-gemini-live-rate-lines.mjs`
  against each environment, with `--dry-run` first, before deploying the API
  and rolling the workers. It adds the token lines for
  `google/gemini-2.5-flash-native-audio-preview-12-2025` at the prices each
  card already charges for `google/gemini-2.0-flash-exp`. The new card
  versions start when it runs, so usage recorded earlier stays unpriced
  (`no_line`).
