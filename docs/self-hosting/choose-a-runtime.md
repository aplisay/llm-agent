---
title: Choose a runtime
description: The five runtimes, what each one needs, and which to enable first.
audience: operator
status: current
---

# Choose a runtime

A runtime is the part that holds the live conversation. The API server stores
the agent and hands each call to the runtime named in the agent's `modelName`.
The part before the colon is the runtime: `livekit:openai/gpt-realtime` runs on
the LiveKit runtime.

A runtime is enabled when its variables are set. `GET /api/health` and
`yarn doctor` show which are enabled and which variables the others are
missing. `GET /api/models` lists only the models of enabled runtimes.

## The runtimes

| Runtime | Calls it carries | What you run | Variables that enable it |
|---|---|---|---|
| `livekit` | Browser (WebRTC) and phone (SIP) | A LiveKit server, and the worker in `agents/livekit` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `pipecat` | Phone (SIP) and browser (WebRTC) | The Python worker in `agents/pipecat`, and a SIP gateway such as `sipbridge` | `PIPECAT_WORKER_URL`, `PIPECAT_DISPATCH_TOKEN`, `PIPECAT_JOIN_SECRET`, `PIPECAT_PUBLIC_URL` |
| `jambonz` | Phone (SIP) | The worker in `agents/jambonz`, and a Jambonz cluster or account | `JAMBONZ_SERVER`, `JAMBONZ_API_KEY` |
| `ultravox` | Browser (WebRTC), and phone through Jambonz | Nothing. The Ultravox cloud is the runtime | `ULTRAVOX_API_KEY` |
| `text` | Text chat, no audio | Nothing. It runs in the API server | None |

## Which to start with

Start with `livekit`. It is the default in the compose stack, which runs the
LiveKit server and the worker for you. With one `OPENAI_API_KEY` you can talk
to an agent in the browser. See [quickstart-local.md](quickstart-local.md).

Add another runtime when you need something it has:

- **`pipecat`** when you want SIP handled by a gateway you run yourself, with
  no LiveKit server in the call path, or a model that only has a Pipecat row
  in `GET /api/models`. It has the most parts to run. It is not in the compose
  stack yet.
- **`jambonz`** when you already operate Jambonz. Numbers come from the Jambonz
  account.
- **`ultravox`** when you want a managed speech-to-speech service and no
  worker.
- **`text`** for chat agents, for tests, and as the text specialist behind a
  voice agent.

You can enable several at once. One instance can serve agents on all of them.

## Model keys

A runtime carries the call. The model does the talking, and each model needs
its provider's key.

- A speech-to-speech model needs one key. `livekit:openai/gpt-realtime` needs
  only `OPENAI_API_KEY`.
- A pipeline model needs three services: a language model, speech-to-text and
  text-to-speech. That is usually two or three keys, for example
  `OPENAI_API_KEY` with `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY`.

The voice workers read the speech keys. The API server reads the model keys
for text agents and to build the model list. In the compose stack both read
the same `.env`, so set each key once.

[configuration.md](configuration.md) lists every variable by component.
