---
title: Troubleshooting
description: Common faults on a self-hosted instance, by symptom, with the check and the fix.
audience: operator
status: current
---

# Troubleshooting

Start with the health report. It needs no API key:

```shell
curl http://localhost:4000/api/health
```

It shows the build, whether the database answers, each runtime and provider as
enabled or disabled, the names of the variables a disabled one is missing, and
warnings. `yarn doctor` prints the same from a source checkout, and the API
server prints it at start. It never shows a value, only names, so it is safe
to paste into an issue.

## Install and start

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose` stops with `run scripts/compose-setup.sh` | `.env` has no secrets. `compose.yaml` has no defaults for them | Run `scripts/compose-setup.sh`, then start again |
| `yarn install` fails with `The engine "node" is incompatible` | Node 23. A test tool refuses to install on it | Use Node 22 LTS or 24. `nvm use` reads `.nvmrc` |
| The API container restarts, and the log has a password error from PostgreSQL | `.env` was deleted and made again, but the `pgdata` volume holds the old password | Restore the old `.env`, or delete the volume with `docker compose down -v` (this deletes the data) |
| A port is already in use | Another program has 4000, 7880, 7881, 7882 or 8080 | Stop it, or set `API_PORT` or `UI_PORT` in `.env`. The LiveKit ports are fixed |
| A warning says `ignored placeholder values (<...>)` | The named variables still hold a `<...>` placeholder from an old template | Set a real value or delete the line |
| The log says `version mismatch, wont upgrade` | The code is newer than the database schema | See [upgrading.md](upgrading.md) |

## API requests

| Symptom | Cause | Fix |
|---|---|---|
| Every request returns 401 | No key, or a wrong key | Send `Authorization: Bearer <key>`. The first key is `BOOTSTRAP_API_KEY` in `.env`, or the one `yarn bootstrap` printed |
| 401 with a message about a Firebase ID token | The key matched no API key, so the server tried it as a sign-in token | The key is wrong. Check for a missing character or a line break |
| `BOOTSTRAP_API_KEY` is set but the key does not work | The database already had a user when the server first saw the key. The setting only works on a database with no users | Make a key with `node tools/agent-admin.js add-authkey`, or start from an empty database |
| `AUTHENTICATE_USERS=NO` has no effect | That mode was removed. Every request needs a key | Remove the line and use an API key |
| `GET /api/models` does not list a model you expect | Its runtime is disabled, or the instance has no key for the provider | Look at `runtimes` and the provider lists in `GET /api/health` |

## Voice calls in the browser

| Symptom | Cause | Fix |
|---|---|---|
| The test page loads agents but the call never connects | The browser cannot reach LiveKit at `LIVEKIT_PUBLIC_URL` | On the same machine the default `ws://localhost:7880` is right. From another machine set `LIVEKIT_PUBLIC_URL` and `LIVEKIT_NODE_IP` to this host's address, and `APLISAY_BIND=0.0.0.0` |
| The call connects but there is no audio in either direction | Media cannot reach `LIVEKIT_NODE_IP` on 7881/tcp or 7882/udp | Open those ports. Set `LIVEKIT_NODE_IP` to an address the browser can reach |
| The call connects, then the agent says nothing | The model's provider key is missing or wrong in the worker | `docker compose logs livekit-worker`. Add the key to `.env` and run `docker compose up -d` |
| The browser never asks for the microphone | The page is not on `localhost` and not on HTTPS. Browsers block the microphone there | Use `localhost`, or put the instance behind TLS (the `edge` profile) |
| A pipeline model fails, a speech-to-speech model works | The speech-to-text or text-to-speech key is missing | See "Model keys" in [choose-a-runtime.md](choose-a-runtime.md) |
| Speech becomes unclear, caller transcripts worsen or false interruptions start after enabling background sound | `always` can mask the agent's voice; `silent` and `always` can leak into the caller's microphone on equipment outside your control | Use the default `thinking` mode at `low`, or disable background sound, and test on a new call. `silent` and `always` are discouraged unless essential. See [background-audio.md](../background-audio.md#audio-quality-what-can-go-wrong) |

## Recordings

| Symptom | Cause | Fix |
|---|---|---|
| A call was not recorded | Recording is off for the agent, or `RECORDING_STORAGE_PATH` is unset | See [../call-recording.md](../call-recording.md). In the compose stack the path defaults to the `recordings` volume |
| The recording exists but the API cannot return it | The worker and the API server do not see the same storage | With `file://` both need the same volume. With `s3://` or `gs://` both need credentials for the bucket |

## Asking for help

Open a GitHub issue. Include:

- the output of `GET /api/health`,
- the version or commit you run,
- what you did, what you expected and what happened,
- the relevant lines of `docker compose logs api` and of the worker's log.

Remove API keys, passwords and phone numbers first. Report a security problem
privately, as [SECURITY.md](../../SECURITY.md) describes, not in an issue.
