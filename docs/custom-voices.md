# Custom voices

An organisation can make its own voices and use them on its agents. Today
there is one kind: an **OpenAI prompt voice** for **GPT-Live**. You describe
the voice in plain words and OpenAI makes it.

A custom voice belongs to the organisation that made it. No other
organisation can see it or use it. Each organisation can hold a limited
number of custom voices (see [Quota](#quota)).

| | |
|---|---|
| Create | `POST /api/models/{modelName}/voices/{locale}` |
| Check progress, or read one | `GET /api/custom-voices/{customVoiceId}` |
| List, with the quota | `GET /api/custom-voices` |
| Delete | `DELETE /api/custom-voices/{customVoiceId}` |
| Use | set an agent's `options.tts.voice` to the voice's `voice` value |
| Models | `pipecat:openai/gpt-live-1`, `livekit:openai/gpt-live-1` |

## How it works

1. **Create** the voice. The call returns `202` at once, with the voice in
   status `creating`.
2. **Poll** the voice until its status is `ready` or `failed`. This usually
   takes about 20 seconds.
3. **Use** it: put its `voice` value in an agent's `options.tts.voice`.
4. **Delete** it when you no longer need it. That frees its place in the
   quota.

## Quick start

Create a voice. URL-encode the model name (`pipecat%3Aopenai%2Fgpt-live-1`):

```bash
curl -X POST "https://llm-agent.example.com/api/models/pipecat%3Aopenai%2Fgpt-live-1/voices/en-GB" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Brighton concierge",
    "prompt": "A warm, unhurried woman in her forties with a soft southern English accent, mid-low pitch, clear and friendly, at a relaxed pace.",
    "gender": "female"
  }'
```

The answer is `202`, with a `Location` header that names the voice:

```json
{
  "id": "6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e",
  "name": "Brighton concierge",
  "vendor": "openai",
  "method": "prompt",
  "voice": null,
  "locale": "en-GB",
  "gender": "female",
  "prompt": "A warm, unhurried woman in her forties with a soft southern English accent, mid-low pitch, clear and friendly, at a relaxed pace.",
  "status": "creating",
  "models": ["pipecat:openai/gpt-live-1", "livekit:openai/gpt-live-1"],
  "createdAt": "2026-10-18T10:15:00.000Z"
}
```

Poll it every 2 to 3 seconds:

```bash
curl "https://llm-agent.example.com/api/custom-voices/6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

When `status` is `ready`, `voice` holds the voice's id (`voice_123abc`). Put
it on a GPT-Live agent:

```json
{
  "name": "Concierge",
  "modelName": "pipecat:openai/gpt-live-1",
  "prompt": "You are the concierge at a seaside hotel.",
  "options": { "tts": { "voice": "voice_123abc" } }
}
```

## Create a voice

`POST /api/models/{modelName}/voices/{locale}`

Path parameters:

| Parameter | Meaning |
|---|---|
| `modelName` | The model the voice is for, URL-encoded. |
| `locale` | Where the voice is listed: a BCP 47 tag such as `en-GB`, or `any`. It does not change how the voice sounds; the prompt does that. |

Body (JSON):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, up to 100 characters. Shown in voice lists. Callers never hear it. |
| `prompt` | yes | A plain description of the voice, up to 2,000 characters. See [Writing the prompt](#writing-the-prompt). |
| `scriptHint` | no | Sample text for OpenAI to speak while it builds the voice, up to 2,000 characters. If you leave it out, OpenAI writes one. Very short scripts are rejected. |
| `gender` | no | `male`, `female` or `neutral`. A label for voice lists. It does not change the voice. |
| `method` | no | `prompt`, the default and the only method today. `recording` returns `501`. |
| `vendor` | no | Leave it out. The model decides the vendor (`openai` for GPT-Live). |

A successful call returns `202` with the voice in status `creating` and a
`Location` header (`/api/custom-voices/{id}`). It takes a place in the quota
straight away.

If the call is refused, nothing is created:

| Status | When |
|---|---|
| `400` | Bad input, or a model that cannot take a custom voice. The `message` says which. |
| `403` | You lack `voice:create`, or the model is not in your allowed models. |
| `409` | The quota is used up: `code: "custom_voice_quota_exceeded"`, with the `quota`. |
| `501` | `method: "recording"`. |
| `503` | Custom voices are not set up on this platform, or the platform has no room for new voices (`code: "custom_voice_platform_limit"`). |

### Writing the prompt

OpenAI builds the voice from a description, not from settings. Describe as
much of this as matters:

- accent, for example "soft southern English" or "Glaswegian";
- age and presentation, for example "a woman in her forties";
- pitch and tone: "mid-low", "bright", "warm", "breathy";
- texture and loudness: "smooth", "slightly gravelly", "quiet";
- pace: "relaxed", "brisk";
- what makes it stand out: "a slight smile in the voice".

OpenAI's rules:

- Describe an adult voice.
- Do not ask for the voice of a real person or a fictional character.

OpenAI turns down a prompt that breaks these rules. You find out when the
voice fails with `errorCode: "rejected"`.

## Wait for the voice

Poll `GET /api/custom-voices/{customVoiceId}` every 2 to 3 seconds until
`status` is no longer `creating`:

| `status` | Meaning |
|---|---|
| `creating` | OpenAI is making the voice. Keep polling. |
| `ready` | Done. `voice` holds the id to use on agents. |
| `failed` | Not made. `error` says why and `errorCode` says what to do. |
| `deleted` | The voice was deleted. Lists leave it out unless you ask for `includeDeleted=true`. |

A create usually takes about 20 seconds. Every create ends as `ready` or
`failed` within a few minutes, so a client can stop polling after about
4 minutes and check again later.

When a voice fails:

| `errorCode` | Meaning | What to do |
|---|---|---|
| `rejected` | OpenAI turned the input down. `error` carries OpenAI's reason. | Change the prompt and create a new voice. |
| `vendor_unavailable` | OpenAI is not taking new voices at the moment. | Try again later. |
| `vendor_error` | OpenAI failed or could not be reached. | Try again. |
| `interrupted` | The create was lost before OpenAI made the voice. | Try again. |

A failed voice does not count against the quota. It stays in the list so you
can show what happened. Delete it to tidy the list.

## Use a voice on an agent

Set `options.tts.voice` to the voice's `voice` value. Leave
`options.tts.vendor` unset, or set it to `openai`.

When you save the agent, the voice must be a `ready` voice of the agent's own
organisation, and the agent's model must be able to use it. Otherwise the save
is refused with `Voice ... not supported by <model>`.

On a call, the model speaks with the voice and is also given the voice's
description, as OpenAI advises for prompt voices. The voice is set when the
call starts. A handover to another GPT-Live agent uses that agent's voice.

`options.vendorSpecific.openai.live.audio.output.voice`, if an agent sets it,
takes precedence over `options.tts.voice`.

If a voice is deleted while an agent still uses it, that agent speaks with
the model's default voice until you choose another.

## Find voices in the voice lists

`GET /api/models/{modelName}/voices/{locale}` lists the organisation's own
`ready` voices for that model first, under the model's vendor (`OpenAI` for
GPT-Live), before the standard voices. A custom voice looks like this:

```json
{
  "name": "voice_123abc",
  "description": "Brighton concierge (custom voice): A warm, unhurried woman in her forties ...",
  "gender": "female",
  "locale": "en-GB",
  "custom": true,
  "customVoiceId": "6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e",
  "label": "Brighton concierge"
}
```

`name` is the value for `options.tts.voice`. `label` is the name to show.
`customVoiceId` is the voice's id under `/api/custom-voices`.

Which locale lists a voice:

- A voice is listed at its own locale.
- A voice made at `any` is listed at every locale.
- Asking for `any` lists all the organisation's voices for the model.

`GET /api/models/{modelName}/voices` includes the locales of the
organisation's custom voices. For GPT-Live, whose standard voices are under
`any`, an organisation with an `en-GB` voice sees `["any", "en-GB"]`.

The agent builder's `list_voices` tool shows the builder's organisation the
same voices, in all three of its modes (locales, one locale, and search).

Custom voices appear in these lists only for callers with `voice:read`.

## List, read and delete

### List

`GET /api/custom-voices` returns the organisation's voices, newest first, and
its quota:

```json
{
  "voices": [ { "id": "...", "name": "Brighton concierge", "status": "ready", "...": "..." } ],
  "quota": { "limit": 3, "used": 1, "remaining": 2 }
}
```

| Query parameter | Meaning |
|---|---|
| `includeDeleted=true` | Also return deleted voices. |
| `modelName=...` | Only voices this model can use. |

### Read one

`GET /api/custom-voices/{customVoiceId}` returns one voice. A voice of another
organisation is a `404`.

### Delete

`DELETE /api/custom-voices/{customVoiceId}` deletes the voice for good, at
OpenAI too, and frees its place in the quota. It returns the voice with status
`deleted`.

| Status | When | What to do |
|---|---|---|
| `409`, `code: "custom_voice_in_use"` | Agents still use the voice. The body lists them in `agents` (`id`, `name`). | Change their voice first, or delete with `?force=true`. Those agents then use the model's default voice. |
| `409` | The voice is still `creating`. | Wait until it is `ready` or `failed`. |
| `502` or `503` | OpenAI could not delete the voice. Nothing has changed. | Try again later. |
| `404` | No such voice in your organisation. | |

A failed voice was never made at OpenAI, so it is simply removed.

There is no rename.

## Quota

Each organisation has `customVoiceLimit`, the most custom voices it can hold.
The default is **3**. `null` means no limit.

`quota.used` counts voices that are `creating` or `ready`. Failed and deleted
voices do not count.

The platform also has a limit on voices across all organisations. When it is
reached, a create returns `503` with `code: "custom_voice_platform_limit"`,
even if the organisation has room.

An organisation cannot change its own limit. The platform sets it:

- a super admin, with `PATCH /api/organisations/{organisationId}` and
  `{ "customVoiceLimit": 10 }` (needs `organisation:setRate`);
- the billing service, with `PATCH /api/organisations/{organisationId}/billing`
  and the same field (needs `organisation:billing`), for example from a plan.

Making a voice adds no usage record. Calls that use it are metered like any
GPT-Live call.

## Permissions

Custom voices use the `voice` permission:

| Role | `voice` actions |
|---|---|
| owner, orgAdmin, superAdmin, audioOnly, textOnly | `create`, `read`, `delete` |
| member, support | `read` |

`create` also needs the model to be in the caller's allowed models. Every call
sees only the caller's own organisation's voices.

## Limits

- GPT-Live only (`pipecat:openai/gpt-live-1` and `livekit:openai/gpt-live-1`).
  One voice works on both.
- Prompt voices only. Voices from a recording are planned (`method: "recording"`
  returns `501`).
- No preview audio. To hear a voice, make a call with it.
- No rename.
