# AGENTS.md

Guidance for AI coding assistants working in this repository. Humans can read
it too.

## What this is

`llm-agent` is the open-source core of the Aplisay voice AI platform. You
define an agent as JSON (prompt, model, voice, tools). The platform runs it on
a phone call (SIP) or in a browser (WebRTC).

- API server: Node.js, ES modules, Express, PostgreSQL. Entry `index.mjs`.
- Voice workers: `agents/livekit` (TypeScript), `agents/pipecat` (Python, with
  the Go SIP gateway `agents/pipecat/sipbridge`), `agents/jambonz` (Node.js).
- The REST contract is `api/api-doc.yaml`. Handlers are in `api/paths/`.

## If you are helping someone run it

Follow [docs/self-hosting/quickstart-local.md](docs/self-hosting/quickstart-local.md).
The short form:

```shell
scripts/compose-setup.sh     # writes .env with random secrets, prints the first API key
docker compose up --build -d
curl http://localhost:4000/api/health
```

Rules that save time:

- Run `scripts/compose-setup.sh` before any `docker compose` command. Compose
  refuses to start without the secrets it writes.
- Check `GET /api/health` before anything else. It needs no key. It names the
  variables each disabled runtime or provider is missing.
- Every other request needs `Authorization: Bearer <key>`. The first key is
  `BOOTSTRAP_API_KEY` in `.env`. There is no unauthenticated mode.
- A spoken conversation needs one model provider key in `.env`. The smallest
  set is `OPENAI_API_KEY` with the model `livekit:openai/gpt-realtime`.
- To test with no provider key, set `APLISAY_STUB_MODEL=1` and use the model
  `text:stub/echo`. It is a text model that repeats its input.
  `scripts/smoke.sh` does this end to end.
- Ask `GET /api/models` and `GET /api/voices` what the instance supports. Do
  not guess model or voice names.
- Never print, log or commit the contents of `.env`.
- Do not use the test page (port 8080) on a public host.

Where to look:

| Question | Read |
|---|---|
| What does this variable do? | [docs/self-hosting/configuration.md](docs/self-hosting/configuration.md) |
| Which runtime? | [docs/self-hosting/choose-a-runtime.md](docs/self-hosting/choose-a-runtime.md) |
| It does not work | [docs/self-hosting/troubleshooting.md](docs/self-hosting/troubleshooting.md) |
| Phone calls | [docs/self-hosting/telephony-routes.md](docs/self-hosting/telephony-routes.md) |
| A newer version | [docs/self-hosting/upgrading.md](docs/self-hosting/upgrading.md) |
| Going public | [docs/self-hosting/production-checklist.md](docs/self-hosting/production-checklist.md) |
| A feature (transfers, recording, tools) | [docs/README.md](docs/README.md) |
| An API operation or schema | `api/api-doc.yaml`, or `GET /api/api-docs` on a running instance |

The Aplisay MCP server at `https://mcp.aplisay.com/mcp` serves these docs and
the API reference to assistants. It is read-only and needs no key.

## If you are changing the code

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/CONTEXT.md](docs/CONTEXT.md).

Set up from source (Node 22 LTS or 24, not 23; yarn 1.x; PostgreSQL):

```shell
yarn install
(cd agents/livekit && yarn install)
cp environment-example .env     # set POSTGRES_* and one provider key
yarn doctor                     # checks settings and the database
yarn bootstrap                  # prints the first API key
yarn develop
```

Checks to run before you say a change is done:

| Changed | Run |
|---|---|
| Anything in `lib/`, `api/`, `middleware/` | `yarn test:no-db` |
| Database models or queries | `yarn test:db` (needs Docker) |
| `agents/livekit` | `(cd agents/livekit && yarn build)` |
| `agents/pipecat` | `(cd agents/pipecat && uv run --frozen -p 3.14 --with pytest python -m pytest tests -q)` |
| `compose.yaml`, Dockerfiles, start-up | `scripts/smoke.sh` (needs Docker) |
| An environment variable | Edit `config/env.schema.json`, then `yarn env:generate` |

Rules:

- Branch from `next` and open pull requests against `next`. `main` is for
  releases only.
- A change to the public API must update `api/api-doc.yaml` in the same
  change.
- Add every new environment variable to `config/env.schema.json`, then run
  `yarn env:generate`. `environment-example` and
  `docs/self-hosting/configuration.md` are generated: do not edit them by
  hand. A test fails if they are out of date.
- `lib/models/livekit.js` imports the compiled LiveKit worker
  (`agents/livekit/dist`). Build the worker before you run the API server or
  its tests.
- Importing `lib/database.js` connects to the database. Do not import it from
  code that must run without one.
- Use `lib/logger.js`, not `console.log`, in server code.
- Do not gofmt `agents/pipecat/sipbridge` wholesale. Keep diffs to the lines
  you change.
- British spelling in docs and user-facing text.
- Do not add a file under `docs/` that starts with a dot. Those paths are
  ignored.

## Layout

| Path | What |
|---|---|
| `index.mjs` | Server entry |
| `api/api-doc.yaml`, `api/paths/` | REST contract and handlers |
| `lib/models/` | Model and runtime adapters |
| `lib/handlers/` | Per-runtime call handling in the API server |
| `lib/database.js`, `lib/database-models/` | Schema and persistence |
| `lib/auth/`, `middleware/auth.js`, `lib/scope.js` | Authentication and tenancy |
| `lib/usage.js` | Usage metering and billing |
| `agents/` | The voice workers |
| `config/env.schema.json` | Every environment variable |
| `scripts/` | Setup, bootstrap, doctor, smoke test |
| `tools/` | Admin and developer command-line tools |
| `tests/` | Jest suites |
| `docs/` | Documentation. Start at `docs/README.md` |
