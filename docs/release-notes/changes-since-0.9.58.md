# Release 0.9.59 (draft) - self-hosting, custom voices, GPT-Live on LiveKit, ElevenLabs Agents

> Draft. Covers changes merged to `next` since the 0.9.58 release point
> (51 pull requests, 18 October - 13 November 2026, up to #470). The version
> number is provisional.

Each item is tagged by subsystem: **core** (API server, REST API, database,
billing, auth, model drivers), **livekit** (LiveKit voice worker and Ultravox
plugin), **pipecat** (Pipecat voice worker), **sipbridge** (SIP gateway used by
Pipecat), and **ci** (build and release pipeline).

## Custom voices - core+livekit+pipecat

- **[core+livekit+pipecat] Where it applies**: GPT-Live only
  (`pipecat:openai/gpt-live-1` and `livekit:openai/gpt-live-1`), and voices
  made from a text prompt only. One voice works on both rows.
- **[core] `POST /models/{modelName}/voices/{locale}`** makes a voice at OpenAI
  from a text prompt. It answers 202 with the voice in status `creating` and a
  `Location` header. Poll the voice until it is `ready` or `failed`; a failed
  voice carries an `errorCode`.
- **[core] `/voices/custom`**: `GET /voices/custom` lists the organisation's
  voices with its quota. `GET`, `PATCH`, and `DELETE` on
  `/voices/custom/{customVoiceId}` read, change, and delete one. A delete also
  removes the voice at OpenAI.
- **[core] `description`**: optional search text of up to 500 characters, set
  at create or with `PATCH`. Voice search reads it ahead of the prompt.
- **[core] `customVoiceLimit`**: the most voices an organisation can hold
  (default 3, `null` for no limit). A super admin or the billing service sets
  it with `PATCH /organisations/{organisationId}` or its `/billing` route.
- **[core] `OPENAI_PROMPT_VOICE_PLATFORM_LIMIT`** caps the voices across all
  organisations (default 100). Past it a create answers 503
  `custom_voice_platform_limit`.
- **[core] `voice` permission**: `create`, `read`, and `delete` for owner,
  orgAdmin, audioOnly, and textOnly; `read` for member and support.
  `voice:managePlatform` is for superAdmin only.
- **[core] Platform voices**: a voice made with `visibility: platform` is
  listed for every organisation and uses none of its quota. `PATCH` with
  `withdrawn` hides it from new agents. `scripts/platform-voices.mjs` copies
  platform voices from one server to another.
- **[core] Voice lists**: `GET /models/{modelName}/voices` and
  `/voices/{locale}` list the organisation's ready voices (`custom: true`),
  then the platform voices (also `platform: true`). A voice is listed at
  every locale of its language.
- **[core] `list_voices` builtin**: offers custom and platform voices first. A
  model id that neither worker lists now returns an error that names the valid
  ids.
- **[livekit+pipecat] Custom voice on a call**: set `options.tts.voice` to the
  voice's `voice` value. An id the server cannot resolve (deleted, or another
  organisation's) falls back to the default voice.
- **[core] Documentation**: new [custom-voices.md](../custom-voices.md).

## GPT-Live - core+livekit+pipecat

- **[core+livekit] `livekit:openai/gpt-live-1`**: OpenAI GPT-Live now runs on
  the LiveKit worker, with the same `delegate` backend, voices, greeting, and
  billing as the Pipecat row. It has no MCP tools, and keypad digits go to the
  voice model only.
- **[core] Delegate `result` builtin**: a save is refused when it leaves a
  `result` builtin on an agent that a `delegate` points at and that runs on an
  `openai/` model. Agent saves and agent-set saves both check. A client
  delegate keeps its `result` function.
- **[core+pipecat] `options.tts.experimentalTranscript`**: removed. An external
  TTS vendor on GPT-Live is now refused at save. An agent saved with the flag
  speaks with GPT-Live's default voice. Use a custom voice instead.
- **[pipecat] Speech-stream audio**: continuous speech from GPT-Live is no
  longer padded or clipped at transcript pauses, on the call or in the
  recording.
- **[core] Documentation**: [gpt-live.md](../gpt-live.md) covers the LiveKit
  row and the delegate rule.

## ElevenLabs Agents - core+livekit+pipecat

- **[core+pipecat] `pipecat:elevenlabs/<llm>`**: ElevenLabs Agents runs on the
  Pipecat worker as four realtime rows, one per LLM (Gemini 2.5 Flash, GPT-5.4
  mini, Claude Haiku 5.5, Claude Sonnet 5.5).
- **[core+livekit] `livekit:elevenlabs/<llm>`**: the same four rows on the
  LiveKit worker, sharing the hosted agents with the Pipecat rows. MCP servers
  are not used on the LiveKit rows.
- **[livekit+pipecat] Tools, greeting, and voice**: functions, builtins, and
  (on Pipecat) MCP tools run as client tools. The greeting text is spoken word
  for word. The voice is any ElevenLabs catalogue voice.
- **[core] `vendorSpecific.elevenlabs.conversation_config`** tunes turn-taking
  and the TTS model. Paths the platform owns are refused at save.
- **[core] Billing**: per minute on the call's voice row.
  `scripts/add-elevenlabs-rate-lines.mjs` seeds the minute lines.
  `scripts/prune-elevenlabs-agents.mjs` removes hosted agents no longer used.
- **[core] Documentation**: new
  [elevenlabs-agents.md](../elevenlabs-agents.md).

## Gemini Live - core+livekit+pipecat

- **[core+livekit+pipecat] Gemini Live model**: the Gemini Live rows are now
  `google/gemini-2.5-flash-native-audio-preview-12-2025` ("Google Gemini 2.5
  Flash Live") on both workers. Google has shut down `gemini-2.0-flash-exp`,
  the model the rows were named after.
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
  record, as for Ultravox, GPT-Live, Grok voice, and ElevenLabs Agents.

## Background sound - core+livekit+pipecat

- **[core+livekit+pipecat] `options.backgroundAudio`**: plays a quiet office
  sound to the caller while the agent works (`when: thinking`, the default),
  whenever the agent is quiet (`silent`), or for the whole call (`always`).
- **[core] Option fields**: `volume` (`low`, `medium`, `high`) and `delayMs`
  (0 to 10000, default 600) tune it. An invalid value is refused at save.
- **[livekit+pipecat] Transfers**: the sound is off during transfers and
  bridged calls. A handover applies the incoming agent's own setting.
- **[livekit+pipecat] Recordings**: Pipecat recordings include the sound.
  LiveKit recordings do not.
- **[livekit+pipecat] Ultravox realtime models**: in `thinking` mode only a
  tool call that runs for longer than `delayMs` starts the sound.
- **[core] Documentation**: new
  [background-audio.md](../background-audio.md).

## Phone system - core

- **[core] Availability**: under development, and off for every organisation
  until a platform operator gives it the `phoneSystem` capability. Without it
  every phone system request answers 403 `phone_system_disabled`. The service
  that carries the calls is not in this release.
- **[core] Directory**: `/directory/entries` and `/directory/extensions` hold
  an organisation's people, teams, and services, with their extensions and
  members.
- **[core] Phones and lines**: `/phones` holds desk phones and outside numbers,
  and the people each one rings for. The platform works out each desk phone's
  lines: `GET /phones/{phoneId}/lines`. A write that can change a phone's keys
  takes `?dryRun=true`.
- **[core] Number routing**: `PUT /phone-endpoints/{number}` takes
  `extensionId`, so a number can ring an extension in place of an agent.
- **[core] Capabilities**: `PUT /organisations/{organisationId}/capabilities`
  sets an organisation's capabilities. It needs `organisation:setCapabilities`.
- **[core] Permissions**: new `directory` (`read`, `update`, `lookup`,
  `readAll`) and `phone` (`read`, `create`, `update`, `delete`, `provision`)
  resources.
- **[core] Call control routes**: internal routes under `/agent-db/pbx`
  (`resolve`, `outbound-authorisation`, `calls`) take `x-callctl-token` only.
  They are closed while `CALLCTL_SHARED_TOKEN` is unset.
- **[core] Documentation**: new [phone-system.md](../phone-system.md).

## Calls and usage - core+livekit+pipecat

- **[pipecat] `options.fallback.agent`**: the agent step of the fallback chain
  now loads the fallback agent, checks it is in the call's organisation, and
  runs it with its own prompt and options. An agent the worker cannot run is
  skipped.
- **[livekit] Pipeline LLM errors**: a pipeline agent whose LLM keeps failing
  after start-up says a short line and ends the call with reason `LLM error`.
  It acts on the first 4xx other than 408 and 429, or the second unrecoverable
  error in a row. The line is `options.fallback.message` when set.
- **[pipecat] Handover usage**: at a full-stack `transfer_agent` handover each
  agent's usage is written to its own call. Only the last agent's usage was
  recorded.
- **[core] Usage for a deleted agent**: worker usage that arrives after its
  agent was deleted is kept, with no agent, and no longer dropped.
- **[pipecat] Deepgram `options.tts.speed`**: sent only to Aura-2 English and
  Spanish voices, as on LiveKit. Any other Deepgram voice ignores the option
  with a warning, where it used to produce no speech.
- **[livekit] Deepgram language**: with `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS`, a
  language tag Deepgram has no regional model for (such as `en-IE`) falls back
  to its base language. An auxiliary or output STT given such a tag did not
  run.
- **[pipecat] Browser tool-call events**: the RTVI
  `llm-function-call-in-progress` and `-stopped` events now carry the function
  name, arguments, and result. The result is the one the model sees, after the
  tool's `redact` setting.
- **[core] Grok rows on Pipecat**: listed only when the API server has
  `XAI_API_KEY` or `GROK_API_KEY`. The built-in xAI voice list gains `aurora`
  and `liora`.
- **[pipecat] Worker runtime**: `pipecat-ai` 1.15.0 on Python 3.14, from
  1.10.0 on 3.12. Cartesia now gets a regional locale it supports (such as
  `en-GB` or `de-DE`) and the base language otherwise.
- **[core] `TransactionLogRow`**: the OpenAPI document lists every `type` that
  `GET /calls/{callId}/logs` returns, including `user-aux` and `agent-speech`.
- **[core] Documentation**: [agent-failover.md](../agent-failover.md) covers
  the fallback agent step and LLM errors after start-up.
  [tts-speed.md](../tts-speed.md) and [grok.md](../grok.md) are updated.

## Call logs - livekit

- **[livekit] Invocation log**: `GET /calls/{callId}/invocation-log` for a
  LiveKit call now also holds the LiveKit Agents SDK and Ultravox plugin lines
  at info and above: the provider connection, each speech turn, the caller
  transcriptions, and the close.
- **[livekit] SDK line format**: these lines carry pino's `msg`, `level`, and
  `time` fields rather than `message`, `severity`, and `timestamp`. The
  Ultravox join URL is no longer logged.
- **[livekit] Idle lines**: runtime stats lines a job process logged while it
  waited for a call are dropped at job start, apart from the latest.
- **[livekit] Early exits**: a job that ends on a setup failure, or in the
  transfer-only handler, now saves its invocation log.

## SIP and telephony - core+pipecat+sipbridge

- **[pipecat] VoiceBlender gateway**: written against the VoiceBlender v0.16
  API. The compose files and the k8s overlay pin `vpbx/voiceblender:0.16.0`.
- **[pipecat] VoiceBlender transfers**: a consultative transfer can finish by
  attended REFER, and falls back to the room bridge. A rejected inbound call
  now stops ringing.
- **[core] Registrar account digests**: schema 72 stores a digest hash beside
  each registrar account's sealed password, so a SIP edge can check
  credentials without `CREDENTIALS_KEY`. A password rotate keeps the old hash
  for 24 hours.
- **[pipecat+sipbridge] `agents/pipecat/docker-compose.yml`**: every variable
  in `agents/pipecat/.env` now reaches the worker and `sipbridge`. Only a
  fixed list did, so `PIPECAT_SIP_OUTBOUND`, some provider keys, and most
  `SIPBRIDGE_*` settings had no effect.
- **[sipbridge] Control API address**: under that compose file the `sipbridge`
  control API now listens on `127.0.0.1:8090`. Set `SIPBRIDGE_API_BIND_ADDR`
  to change it.
- **[pipecat+sipbridge] Guide**: [byo-trunk-sipbridge.md](../self-hosting/byo-trunk-sipbridge.md)
  takes a self-hoster from a provider's SIP trunk to inbound and outbound
  calls on the Pipecat runtime. Draft: the signalling was checked, a call with
  audio through a provider was not.
- **[core+pipecat] Documentation**:
  [voiceblender-integration.md](../voiceblender-integration.md) gains a
  version section. [credentials-at-rest.md](../credentials-at-rest.md)
  describes the digest columns.

## Self-hosting - core+livekit+ci

- **[core+livekit] `compose.yaml`**: `docker compose up` starts PostgreSQL,
  the API server, a LiveKit server, the LiveKit worker, and the test page, with
  ports on 127.0.0.1. Optional `sip-livekit` and `edge` (Caddy) profiles.
- **[core] `scripts/compose-setup.sh`** writes `.env` with random secrets and a
  first API key, and prints the key and the URLs. `compose.yaml` has no default
  secrets and stops with an error until `.env` has them.
- **[core] `scripts/compose-setup.sh --accounts`** turns on user accounts for
  the compose bundle: it sets `BETTER_AUTH_ENABLED`, a session secret, the API
  address, and the trusted front-end origins.
- **[core] `compose.yaml` host access**: the API container can reach a worker
  on the host network at `host.docker.internal`.
- **[core] Test page**: `tools/test-page` is a small page that talks to a
  LiveKit agent in the browser. It runs as the compose `ui` service and is
  never served by the API server.
- **[core] `APLISAY_STUB_MODEL`**: set to `1` to list `text:stub/echo`, a text
  model that repeats its input and needs no provider key. For smoke tests
  only. Unset, the model is neither listed nor usable.
- **[ci] Smoke test**: `scripts/smoke.sh` starts the compose stack, uses the
  first API key, creates an agent, and runs a text chat round trip. A GitHub
  Actions workflow runs it on every pull request to `next`.
- **[core] Documentation**: new
  [quickstart-local.md](../self-hosting/quickstart-local.md),
  [user-accounts.md](../self-hosting/user-accounts.md), and more pages under
  [self-hosting](../self-hosting/README.md).
- **[core] Repository guides**: new `AGENTS.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and issue templates.

## Authentication - core

- **[core] `AUTHENTICATE_USERS=NO`**: removed. Every request now needs an API
  key. The setting is ignored, with a warning at start. In 0.9.58 it answered
  500 on every request.
- **[core] `yarn bootstrap`**: on a database with no users, creates one
  organisation, one `superAdmin` user, and one API key, and prints the key.
  Options `--key`, `--org`, `--name`, and `--email`.
- **[core] `BOOTSTRAP_API_KEY`**: set it to a random value of 32 characters or
  more and the server does the same when it first starts, with that key. It is
  ignored once any user exists.
- **[core] Firebase sign-in**: `firebase-admin` loads on first use, so an
  instance that uses API keys alone needs neither the package nor Google
  credentials. On an instance with no Firebase project, an unknown token
  answers 401 `Authentication error: unknown API key or token`.
- **[core] `yarn auth:generate`** fetches `@better-auth/cli` on demand, so a
  default install no longer builds `better-sqlite3`.
- **[core] `yarn auth:migrate`** now runs `scripts/auth-migrate.mjs`, which
  uses the better-auth version the server runs. The older pinned tool made an
  `account` table the server could not use.
- **[core] `CORS_ORIGINS`**: extra browser origins allowed to call the API,
  comma separated, for a front end served from another origin.
- **[core] `/agent-db` path detection**: the auth middleware matches the
  internal `/agent-db` routes on the parsed path, ignoring case, as the router
  does.
- **[core] Documentation**: [running.md](../running.md#first-api-key) covers
  the first API key.

## Configuration and health - core+livekit

- **[core] `config/env.schema.json`**: one entry per environment variable the
  API server, both voice workers, and sipbridge read. `yarn env:generate`
  builds the templates and the new
  [configuration reference](../self-hosting/configuration.md) from it.
- **[core] `environment-example`**: rebuilt as a short template with every
  provider commented out and no placeholder strings. User sign-up and email are
  off; their settings moved to `environment-example.polite-ai`.
  `SERVICE_BASE_URI` now names port 4000.
- **[core+livekit] Placeholder values**: a value written as `<...>` is treated
  as unset, with a warning at start.
- **[core] `yarn doctor`**: lists each runtime and provider as enabled or
  disabled, names what a disabled one is missing, and checks the database.
  The server logs the same table at start.
- **[core] `GET /api/health`**: needs no API key. Returns the same table as
  JSON, and 503 when the database does not answer. It names unset variables
  and never returns a value.
- **[core] `GET /api/health` `features`**: says whether user accounts, the
  agent-set builder, and SIP registration are available, so a front end can
  hide what the instance cannot do. `yarn doctor` prints the same.
- **[core] Builder availability**: the agent-set builder is off when the
  provider of `SET_BUILDER_MODEL` has no key. The `features` entry names the
  missing variable.
- **[core] Database settings**: a missing `POSTGRES_PORT` stops the server
  with a message, not an `Invalid URL` error. Other missing `POSTGRES_*`
  settings are named in a warning.
- **[core] Listen port**: the API server reads `PORT` when `WS_PORT` is unset,
  so it listens where Cloud Run, Kubernetes, and most container platforms
  expect. `WS_PORT` still wins when both are set.
- **[core] `SERVICE_BASE_URI`**: documented as the API server's base URL
  without `/api`, which is what the workers expect.
- **[core] `SET_BUILDER_MCP_URL` default**: the agent-set builder reads the
  released docs at `https://mcp.aplisay.com/mcp` unless `NODE_ENV` is
  `development` or `staging`, where it still reads the next channel. Every
  instance read the next channel unless the variable was set.
- **[core+livekit] Node version**: both `package.json` files declare Node 22
  or later in `engines`, and `.nvmrc` names 22. Node 22 LTS and 24 are
  supported; Node 23 is not, because the test tools refuse to install on it.

## Images and deployment - core+livekit+pipecat+sipbridge+ci

- **[ci] Public images**: when the repository variable
  `PUBLISH_PUBLIC_IMAGES` is `true`, each `v*` tag builds `aplisay-api`,
  `aplisay-livekit-worker`, `aplisay-pipecat-worker`, and `aplisay-sipbridge`
  for amd64 and arm64, and pushes them to `ghcr.io/aplisay` with an SBOM.
- **[ci] GitHub Release**: the same workflow publishes a release from
  `docs/release-notes/<tag>.md`.
- **[core] Plain environment**: every image runs from plain environment
  variables; a `SECRETENV_KEY`/`SECRETENV_BUNDLE` pair is optional.
- **[core] API image credential**: an image built without secretenv build
  args carries no `credentials/google.json`. The server writes the file at
  start from `GOOGLE_CREDENTIAL` when it is missing. Builds with the args are
  unchanged.
- **[livekit+pipecat] Google credential file**: both workers write the file
  from `GOOGLE_CREDENTIAL` at start when it is missing. LiveKit no longer
  needs the image entrypoint for this, and Pipecat no longer needs a secretenv
  bundle.
- **[core] API image start-up**: the image compiles the LiveKit model registry
  at build time, so a container no longer runs a TypeScript build on every
  start.
- **[livekit] Image build check**: the worker image build now fails when the
  built worker cannot load.
- **[sipbridge] arm64 image**: the build now compiles for the target platform.
- **[core+livekit] `bundle-secretenv.sh`** uses the repo's installed secretenv,
  and its `npx` fallback is pinned to `v1.0.5`.
- **[core+livekit] LiveKit worker scripts**: `yarn livekit-dev` (repo root),
  and `yarn start`, `yarn stage`, and `yarn develop` in `agents/livekit`, now
  start the worker. `yarn livekit-dev` reads the repo-root `.env`. A Linux
  checkout can now run the worker from source.
- **[livekit] Runner shutdown**: `agents/livekit/deploy/gcp/shutdown-script.sh`
  drains the worker when a GCE runner VM stops, so LiveKit stops sending jobs
  to it. `deploy-cos.sh` adds it to new VMs.
- **[core] Repository tidy**: removed `API.md` (the OpenAPI document
  `api/api-doc.yaml` is the reference), `agent.json`, `websocket-monitor.js`,
  `CNAME`, the gulp and jsdoc doc build, and the unused `uk-number-validator`
  submodule.
- **[core] Documentation**: [running.md](../running.md#deploying) covers
  plain-environment deploys and gives each image's build command.

## Recording storage - core+livekit+pipecat

- **[core+livekit+pipecat] `RECORDING_STORAGE_PATH`** now also takes
  `s3://bucket/prefix` (S3 or an S3-compatible store) and `file:///directory`,
  beside `gs://`.
- **[core+livekit+pipecat] S3 settings**: `S3_ENDPOINT`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN`, and
  `S3_FORCE_PATH_STYLE`.
- **[core+livekit+pipecat] Recording without storage**: with
  `RECORDING_STORAGE_PATH` unset and no Google credentials, a requested
  recording is skipped with a warning, and recording downloads answer 503.

## Upgrade notes

- **[core] Database schema migrates from v68 to v73**:
  - v69 `custom_voices` and `organisations.custom_voice_limit`.
  - v70 `custom_voices.visibility` and `withdrawn_at`.
  - v71 `custom_voices.description`.
  - v72 `phone_registrations.ha1`, `previous_ha1`, and `previous_ha1_until`.
  - v73 the phone system directory tables, `phone_numbers.extension_id`, and
    new `organisations` columns.
  - All five are applied on every boot. None needs `DB_FORCE_SYNC`.
- **[core] New optional environment**: `BOOTSTRAP_API_KEY`, `CORS_ORIGINS`,
  `APLISAY_STUB_MODEL`, `OPENAI_PROMPT_VOICE_PLATFORM_LIMIT`, `PBX_RELEASE`,
  `PBX_REGISTRAR_DOMAIN`, and `CALLCTL_SHARED_TOKEN`.
- **[core+livekit+pipecat] New optional environment**: `S3_ENDPOINT`,
  `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN`,
  and `S3_FORCE_PATH_STYLE`.
- **[livekit+pipecat] New optional environment**: `ELEVENLABS_AGENT_PREFIX`
  and `ELEVENLABS_API_BASE`. The ElevenLabs Agents rows need
  `ELEVENLABS_API_KEY` on the API server and on the worker.
- **[core] `AUTHENTICATE_USERS`**: remove it. Make the first API key with
  `yarn bootstrap` or `BOOTSTRAP_API_KEY`.
- **[core+livekit+pipecat] `RECORDING_STORAGE_PATH`**: set it on the API server
  and both workers. An instance with Google credentials keeps the old default
  bucket for now, and the start-up log asks for the variable.
- **[core] Gemini Live rate lines**: run `scripts/add-gemini-live-rate-lines.mjs`
  against each environment, with `--dry-run` first, before deploying the API
  and rolling the workers. The new card versions start when it runs, so usage
  recorded earlier stays unpriced (`no_line`).
- **[core] ElevenLabs rate lines**: run `scripts/add-elevenlabs-rate-lines.mjs`
  against each environment before agents use the ElevenLabs Agents rows. Set
  `ELEVENLABS_VOICE_PRICE_MICROS`, or it copies each card's Ultravox minute
  price as a placeholder.
- **[core] Agent saves**: a save can now be refused for a `result` builtin on
  an OpenAI-hosted delegate, an external TTS vendor on GPT-Live, or an invalid
  `options.backgroundAudio`.
- **[core] Grok rows on Pipecat**: set `XAI_API_KEY` on the API server to keep
  them listed.
- **[core] `SET_BUILDER_MCP_URL`**: set it on an instance that should keep
  reading the next channel docs and whose `NODE_ENV` is neither `development`
  nor `staging`.
- **[pipecat] VoiceBlender engine**: move the engine to 0.16 with the worker.
  A deployment that runs its own engine container sets `SIP_BIND_IP`,
  `SIP_EXTERNAL_IP`, `SIP_DOMAIN`, and `SIP_CODECS`; the engine does not read
  `EXT_IP_ADDRESS` or `API_KEY`.
- **[pipecat] Python**: a worker run from source needs Python 3.14.
- **[pipecat+sipbridge] `agents/pipecat/.env`**: check it before the upgrade.
  Settings that had no effect under `agents/pipecat/docker-compose.yml` now
  apply.
- **[sipbridge] `SIPBRIDGE_API_BIND_ADDR`**: set it if anything outside the
  host calls the `sipbridge` control API under that compose file.
- **[livekit] Runner shutdown script**: run
  `agents/livekit/deploy/gcp/install-shutdown-script.sh` once against existing
  GCE runners. New VMs from `deploy-cos.sh` get it.
- **[livekit] Invocation log clients** that read line fields must accept
  `msg`, `level`, and `time` as well as `message`, `severity`, and
  `timestamp`.
