# Custom voices

An organisation can create its own voices and use them on its agents. The
first and only method is an **OpenAI prompt voice** on **GPT-Live**: you
describe the voice in plain language and OpenAI generates it. Voices cloned
from a recording, and other vendors, are designed for below but not built yet
(see [Other options](#other-options)).

A custom voice belongs to the organisation that created it. No other
organisation can list it, read it, or put it on an agent. Each organisation
has a quota of custom voices.

| | |
|---|---|
| Create | `POST /api/models/{modelName}/voices/{locale}` |
| List, with the quota | `GET /api/custom-voices` |
| Read one | `GET /api/custom-voices/{customVoiceId}` |
| Delete | `DELETE /api/custom-voices/{customVoiceId}` |
| Use | an agent's `options.tts.voice` set to the voice's `voice` value |
| Models (today) | `pipecat:openai/gpt-live-1` |

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

It returns `202` at once, with a `Location` header and the voice in
`status: "creating"`:

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
  "models": ["pipecat:openai/gpt-live-1"],
  "createdAt": "2026-10-18T10:15:00.000Z"
}
```

OpenAI then makes the voice in the background. That takes about 20 seconds
(21 s in a test on 2026-10-18). Poll the voice every few seconds until
`status` is `ready` or `failed`:

```bash
curl "https://llm-agent.example.com/api/custom-voices/6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

When it is ready, `voice` holds OpenAI's id (`voice_123abc`). Put that value on
a GPT-Live agent:

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
| `modelName` | The model the voice is for. URL-encode `:` and `/`. The vendor is the model's own: OpenAI for GPT-Live. |
| `locale` | Where the voice is listed: a BCP 47 tag such as `en-GB`, or `any`. It does not change how the voice sounds; the prompt does that. |

Body (JSON):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, up to 100 characters. Shown in voice lists. Callers never hear it. |
| `prompt` | yes | A plain-language description of the voice, up to 2,000 characters. See [Writing the prompt](#writing-the-prompt). |
| `scriptHint` | no | Sample text for OpenAI to speak while it builds the voice, up to 2,000 characters. If omitted, OpenAI writes one from the prompt. Very short scripts are rejected. |
| `gender` | no | `male`, `female` or `neutral`. A label for voice lists and search. It does not change the voice. |
| `method` | no | `prompt` (the default). `recording` is reserved and returns `501`. |
| `vendor` | no | Defaults to the only vendor that can make this kind of voice for the model (`openai`). Naming another vendor returns `400`. |

Before it returns, the server checks the input, takes a slot from the quota
and stores the voice as `creating`. It returns `202` with the voice and a
`Location` header (`/api/custom-voices/{id}`). It then calls OpenAI's
`POST /v1/audio/voices` in the background, with `type: "prompt"`, the
`prompt`, `model: "auto"` and, when given, `script_hint`. The name sent to
OpenAI is `aplisay-<id>`, not the customer's name (see
[How the background create works](#how-the-background-create-works)). When
OpenAI answers, the voice becomes `ready` with OpenAI's voice id in `voice`.
OpenAI returns no preview audio.

Errors from `POST` (nothing is created):

| Status | When |
|---|---|
| `400` | Bad input, or a model with no custom voices. |
| `403` | The caller lacks `voice:create`, or the model is not in the caller's allowed models. |
| `409` | The organisation's quota is used up. The body has `code: "custom_voice_quota_exceeded"` and the `quota`. |
| `501` | `method: "recording"`. |
| `503` | OpenAI custom voices are not configured on this platform, or the platform has no slots left (`code: "custom_voice_platform_limit"`). |

Errors from OpenAI arrive later, on the voice: `status: "failed"`, with an
`error` message and an `errorCode`:

| `errorCode` | Meaning | What to do |
|---|---|---|
| `rejected` | OpenAI refused the input, for example a prompt that names a real person. The `error` carries OpenAI's reason. | Change the prompt and create again. |
| `vendor_unavailable` | OpenAI is refusing new voices for now (rate or voice limit). | Try again later. |
| `vendor_error` | OpenAI failed or could not be reached. | Try again. |
| `interrupted` | The server lost the create, and OpenAI has no such voice. | Try again. |

A failed voice does not count against the quota. `GET /api/custom-voices`
shows failed voices so a UI can explain what happened. Delete them to tidy the
list.

### How the background create works

The API server runs on Cloud Run with CPU throttling on (staging, checked
2026-10-18): work left running after a response only gets CPU while another
request is in flight. A server can also restart in the middle of a create. So
the server does not trust the background job alone:

1. **The job.** It starts as `POST` returns, and normally finishes in about
   20 seconds. It gives OpenAI 60 seconds. If no answer comes back (a timeout
   or a network failure), OpenAI may still have made the voice, so the job
   leaves it `creating` for the next step to settle.
2. **The name tag.** The voice is created at OpenAI under the name
   `aplisay-<id>`, where `<id>` is our voice id. OpenAI's list can then show
   whether a create that we lost track of did make the voice.
3. **Polls settle quiet creates.** When `GET /api/custom-voices/{id}` or
   `GET /api/custom-voices` sees a voice still `creating` after 90 seconds,
   and no job for it runs in that process, it looks in OpenAI's list
   (`GET /v1/audio/voices`) during the request. If the voice is there, it
   becomes `ready`. If it is still not there after 3 minutes, it becomes
   `failed` with `errorCode: "interrupted"`.
4. **A sweep.** The server does the same every minute for every
   organisation's quiet creates, so a voice nobody polls is still settled.
5. **A create that lands too late.** If OpenAI answers after the voice was
   marked failed, the voice still becomes `ready`. If the user has deleted it
   by then, the server deletes the new voice at OpenAI, so it holds no slot.

A voice that is `creating` cannot be deleted (`409`); wait until it is `ready`
or `failed`.

### Writing the prompt

OpenAI builds the voice from prose, not from parameters. Describe as many of
these as matter:

- accent, for example "soft southern English" or "Glaswegian";
- age and presentation, for example "a woman in her forties";
- pitch and timbre: "mid-low", "bright", "warm", "breathy";
- texture and loudness: "smooth", "slightly gravelly", "quiet";
- speech rate: "relaxed", "brisk";
- what makes it stand out: "a slight smile in the voice".

Rules from OpenAI:

- Describe an adult voice.
- Do not ask for the voice of a named person or fictional character. OpenAI
  rejects these prompts, and the API returns `400`.

Each successful request makes a new voice and uses a quota slot until the
voice is deleted (see [Quota](#quota)).

## Where the voice is listed

`GET /api/models/{modelName}/voices/{locale}` lists the organisation's own
ready voices for that model first in their vendor's list (`OpenAI` on
GPT-Live), before the stock voices. A custom voice row looks like this:

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

`name` is the value for `options.tts.voice`. `label` is the display name.

Locale rules:

- A voice is listed at its own locale.
- A voice made at `any` is listed at every locale.
- Asking for `any` lists every custom voice for the model.

`GET /api/models/{modelName}/voices` adds the locales of the organisation's
custom voices to the locale list. For GPT-Live, whose stock voices sit under
`any`, an organisation with an `en-GB` custom voice sees `["any", "en-GB"]`.

The caller needs `voice:read` to see custom voices in these lists. Without it
the lists show only the stock voices.

## Use the voice on an agent

Set `options.tts.voice` to the voice's `voice` value. Leave
`options.tts.vendor` unset or set it to `openai`.

The agent save checks that the voice is a **ready** voice of the **agent's own
organisation** and that the agent's model can speak it. An id another
organisation made, a deleted voice, or a model that cannot use the voice is
rejected with the usual `Voice ... not supported by ...` error.

At call time the Pipecat worker loads the agent from the API server, which
adds a `customVoice` block when `options.tts.voice` is one of the
organisation's ready voices:

```json
"customVoice": {
  "id": "6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e",
  "vendor": "openai",
  "method": "prompt",
  "voice": "voice_123abc",
  "name": "Brighton concierge",
  "prompt": "A warm, unhurried woman ...",
  "locale": "en-GB"
}
```

The worker then:

- sends the voice in `session.start` as `session.audio.output.voice: { "id": "voice_123abc" }`
  (OpenAI takes a custom voice as an object and a stock voice as a string);
- adds `Your speaking voice: <prompt>` to the voice model's instructions, as
  OpenAI asks for prompt voices.

`options.vendorSpecific.openai.live.audio.output.voice` still wins if an agent
sets it.

If the voice was deleted after the agent was saved, the server adds no
`customVoice` block. The worker then logs a warning and speaks with the
default voice (`marin`) rather than fail the call.

The voice is fixed when the session starts. A handover to another GPT-Live
agent starts a new session with that agent's voice.

## Manage voices

### List

`GET /api/custom-voices` returns the organisation's voices, newest first, and
its quota:

```json
{
  "voices": [ { "id": "...", "name": "Brighton concierge", "status": "ready", "...": "..." } ],
  "quota": { "limit": 3, "used": 1, "remaining": 2 }
}
```

Query parameters:

| Parameter | Meaning |
|---|---|
| `includeDeleted=true` | Also return deleted voices. |
| `modelName=...` | Only voices this model can speak. |

### Read one

`GET /api/custom-voices/{customVoiceId}`. Another organisation's voice is a
`404`.

### Delete

`DELETE /api/custom-voices/{customVoiceId}` deletes the voice at OpenAI, then
marks it deleted here. It leaves the voice lists, no agent can be saved with
it, and it stops counting against the quota.

- While an agent of the organisation still uses the voice, the delete is
  refused with `409`, `code: "custom_voice_in_use"` and the `agents` that use
  it. Change their voice first, or delete with `?force=true`. After a forced
  delete those agents speak with the default voice until their voice is
  changed.
- A voice still being created cannot be deleted (`409`).
- If OpenAI cannot delete the voice, the delete returns `502` (or `503` when
  OpenAI is busy) and nothing changes here. Try again later.
- A voice OpenAI no longer has is deleted here as normal.
- A failed voice has nothing at OpenAI, so it is deleted here only.

### Deleting at OpenAI

OpenAI's API reference and its SDK (`openai` 7.38.0) list only a create call
for voices. The API does serve `DELETE /v1/audio/voices/{voice_id}` and
`GET /v1/audio/voices`. On 2026-10-18 one real voice was created through this
API, appeared in OpenAI's list, and was deleted:

- the delete took about 1 second and OpenAI replied
  `{ "id": "voice_...", "object": "audio.voice.deleted", "deleted": true }`;
- the voice then left OpenAI's list;
- a second delete of the same id returned `404` "No voice found with id ...".

Because these calls are not documented:

- OpenAI may change them without notice.
- OpenAI has not confirmed that a delete frees one of the 100 slots
  (see [The platform-wide cap](#the-platform-wide-cap)).
- The server treats any 2xx as deleted. It treats a `404` as already gone
  only when the message says "No voice found". A `404` can also mean the
  project has no custom voice access, and then the voice is still there.
- The row keeps OpenAI's reply under `vendor_data.deletion`, for audit.

There is no rename yet.

## Ownership and permissions

Every custom voice row records the organisation that created it and the user
who did. Every read, list, delete, voice list, agent save and worker fetch is
scoped to that organisation.

The `voice` RBAC resource has three actions:

| Role | `voice` actions |
|---|---|
| owner, orgAdmin, superAdmin | `create`, `read`, `delete` |
| member, support | `read` |
| service roles (billing, onboarding, analysis) | none |

`create` also needs the model to be in the caller's allowed models.

## Quota

Each organisation has `customVoiceLimit`: the most custom voices it may hold.
The default is **3**. `null` means no limit.

`used` counts voices being created or ready. Failed and deleted voices do not
count. (For a future vendor with no delete call, its deleted voices would
still count, because the vendor still holds them.)

Only the platform can change the quota, because the vendor's limit is shared
by every customer:

- a super admin, with `PATCH /api/organisations/{organisationId}` and
  `{"customVoiceLimit": 10}` (needs `organisation:setRate`);
- the billing service, with `PATCH /api/organisations/{organisationId}/billing`
  and the same field (needs `organisation:billing`), so a subscription
  package can set it.

An orgAdmin cannot raise their own organisation's quota.

### The platform-wide cap

OpenAI allows **100 prompt voices per OpenAI organisation**, and Aplisay's
OpenAI organisation serves every customer. On top of the per-organisation
quota, the server refuses a new OpenAI prompt voice with `503`
(`code: "custom_voice_platform_limit"`) once the platform holds as many as
`OPENAI_PROMPT_VOICE_PLATFORM_LIMIT` (default 100). Deleted voices do not
count, on the basis that OpenAI's delete frees the slot. If it turns out not
to, OpenAI will refuse new voices before this cap is reached, and the API
passes OpenAI's error on.

The quota check and the new row are written under one Postgres advisory lock,
so two requests cannot both take the last slot. The OpenAI call runs after
that, outside any transaction.

## Platform setup

For operators.

- `OPENAI_API_KEY` on the API server makes and deletes the voices. It must
  be a **project-scoped** key with the `api.voices.write` scope, on a project
  that OpenAI has approved for GPT-Live and custom voices.
- The Pipecat worker's `OPENAI_API_KEY` speaks with them. It must be a key of
  the **same OpenAI project**, with `api.voices.read`. A voice belongs to the
  project that made it, and a key from another project cannot use it.
- The 100-voice cap is per OpenAI **organisation**, not per project. If
  staging and production share an OpenAI organisation, set
  `OPENAI_PROMPT_VOICE_PLATFORM_LIMIT` in each environment so the total stays
  within 100 (for example 10 on staging and 90 on production).
- Without `OPENAI_API_KEY` on the API server, create returns `503`.
- Creating a voice through `/v1/audio/voices` is not compatible with OpenAI's
  Zero Data Retention. Calls that use the voice can still be ZDR-eligible.
- Creation is free at OpenAI. Calls are billed at the normal GPT-Live minute
  rate, so there is no new usage row.

Schema 69 adds the `custom_voices` table and
`organisations.custom_voice_limit`. Both are also created on every boot when
missing, so a deployment that is not force-synced still gets them.

### The `custom_voices` table

| Column | Meaning |
|---|---|
| `id` | Our id, used under `/custom-voices`. |
| `organisation_id` | The owner. No foreign key: rows outlive anything that would cascade, because the vendor still holds the voice. |
| `created_by` | The user who created it. |
| `vendor`, `method` | `openai`, `prompt`. |
| `vendor_voice_id` | The vendor's id (`voice_...`). Unique per vendor. |
| `name`, `prompt`, `locale`, `gender` | As given. |
| `status` | `creating`, `ready`, `failed` or `deleted`. |
| `error` | Why the vendor failed. |
| `vendor_data` | The vendor's response, kept for audit. |
| `deleted_at` | When it was deleted. Rows are never destroyed. |

## Limits and known gaps

- Only GPT-Live on Pipecat. When a LiveKit GPT-Live row lands, the server
  already treats `livekit:openai/gpt-live*` as able to use these voices, but
  the LiveKit worker must send the voice as `{ "id": ... }` and add the prompt
  to its instructions in the same way.
- The builder's `list_voices` tool does not see custom voices yet.
- No preview audio: OpenAI returns none. The only way to hear a voice is a
  call with it.
- No rename.
- A voice the user cannot see is made only if OpenAI's list stops answering
  for 3 minutes while OpenAI also makes the voice. It would then hold one of
  the 100 slots. Find it by its `aplisay-<id>` name.
- The delete call at OpenAI is not documented (see
  [Deleting at OpenAI](#deleting-at-openai)).

## Other options

None of this is built. It records how the API is meant to grow, so that the
first version does not block it.

### How a new method or vendor fits

The vendors live in `lib/custom-voices/drivers.js`. A driver names, for each
method it supports:

- which models can speak a voice made that way (`supportsModel`);
- the function that creates the voice;
- the call that deletes the voice at the vendor (`deleteVoice`), when the
  vendor has one;
- the platform-wide cap and its environment variable.

The create endpoint stays the same: `POST /models/{modelName}/voices/{locale}`
with `method` and, where a model can use more than one vendor, `vendor`. A
pipeline model that can render voices from ElevenLabs and Cartesia, for
example, would need `vendor` in the body.

For a discrete TTS vendor, the voice id goes straight into
`options.tts.voice` and the workers already pass it through unchanged
(ElevenLabs, Cartesia and Neuphonic all take their own voice ids). Most of
the work is on the server: the driver, and the catalogue key the voice is
listed under (`elevenlabs`, `cartesia`, `neuphonic`).

Two things change once organisation provider keys (BYOK) land:

- a voice made with the organisation's own key lives in that organisation's
  vendor account, so it should not count against the platform cap;
- only that key can use the voice, so the row must record which key made it,
  and the worker must use the same key.

### OpenAI: a voice from a recording

OpenAI can also clone a voice from a short recording. It is limited to
eligible customers (OpenAI sales enables it), and to 20 voices per OpenAI
organisation.

OpenAI's flow:

1. `GET /v1/audio/consent_phrases` lists the consent phrases. There are
   phrases for 16 languages.
2. The speaker reads one phrase exactly. Upload it with
   `POST /v1/audio/voice_consents` (multipart: `name`, `language`,
   `recording`). It returns a consent id such as `cons_123abc`. One consent
   covers several voices from the same speaker. Consents can be listed, read,
   renamed and deleted.
3. `POST /v1/audio/voices` (multipart: `name`, `audio_sample`, `consent`)
   makes the voice. The consent and the sample must be the same person.

Sample rules: 30 seconds or less; at least 5 seconds of speech and 15 tokens
of transcribed text; for GPT-Live, 10 to 30 seconds of several complete
sentences; `mpeg`, `wav`, `ogg`, `aac`, `flac`, `webm` or `mp4`; up to
10 MiB. A browser recording labelled `audio/webm;codecs=opus` is rejected:
send it as `audio/webm`.

A recording voice works on more models than a prompt voice: GPT-Live (English
accents only), `gpt-realtime-2`, `gpt-4o-mini-tts` and Chat Completions audio
output. Check which of our OpenAI Realtime rows that covers before enabling
it there. On GPT-Live, state the accent in the instructions ("Speak British
English").

Planned shape here:

- `GET /api/custom-voices/consent-phrases?language=en` passes OpenAI's list
  through.
- `POST /api/custom-voices/consents` (multipart: `name`, `language`,
  `recording`) stores a consent row owned by the organisation, with OpenAI's
  consent id. `DELETE` on it deletes the consent at OpenAI too.
- `POST /api/models/{modelName}/voices/{locale}` as multipart with
  `method=recording`, `audioSample` and `consentId`. The server checks that
  the consent belongs to the same organisation.
- The server passes the audio through and does not store it. It keeps the
  vendor ids only.
- The worker for each model that can use a recording voice sends
  `{ "id": ... }` in the same way as for a prompt voice.

### Other vendors

From each vendor's API reference, checked on 2026-10-18.

| Vendor | Text prompt | Clip clone | Delete via API | Limits | Fit here |
|---|---|---|---|---|---|
| ElevenLabs | Yes, two steps: `POST /v1/text-to-voice/design` returns previews, `POST /v1/text-to-voice` saves one | Yes: `POST /v1/voices/add` (multipart `files[]`) | Yes: `DELETE /v1/voices/{voice_id}` | Voice slots per plan (for example 30 on Creator, 160 on Pro) | Good. Pipeline TTS on both workers takes the voice id. The design step needs a preview flow (below). |
| Cartesia | Not in the current API | Yes: `POST /voices/clone` (multipart `clip`, `name`, `language`; up to 16 MB, about 10 to 60 s), synchronous | Yes: `DELETE /voices/{id}` | Not published for instant clones | Good. Pipeline TTS and Ultravox external TTS take the voice id. `POST /voices/localize` can make an accent variant. |
| Neuphonic | Not in the API | Yes: `POST /voices` (multipart `voice_file`), plus an "assisted" clone from a script | Yes: `DELETE /voices/{voice_id}` | Not published | Good. Pipeline TTS takes the voice id. |
| Inworld | Yes, two steps: `voices:design` returns previews, `{voiceId}:publish` saves one | Yes: `voices:clone` (base64 WAV or MP3, 3 to 30 s) | Yes | Per plan (100 and up) | Needs Inworld TTS support in the workers first. |
| xAI | No | Yes: `POST /v1/custom-voices` (multipart, up to 120 s) | Yes | 30 per team | API creation is for Enterprise teams only, and US only. Would suit the Grok voice row. |
| Ultravox | No | Yes: `POST /api/voices` (multipart, 30 to 60 s, up to 10 MB) | Yes | One cloned voice per account | Not usable for many customers on the platform account. Fits BYOK only. |
| Google (Chirp 3 HD) | No | Yes, allow-listed: `voices:generateVoiceCloningKey` with a consent recording | No: the key is held by the caller | None on keys | Our LiveKit Google TTS uses Gemini TTS, not Chirp, so this needs worker work. The key is a secret to store encrypted. |
| Deepgram | No | No | n/a | n/a | No custom voice API. |

Points from this that shape the design:

- **Previews.** ElevenLabs and Inworld design voices in two steps: one call
  returns several previews with audio, a second call saves one. That fits as
  a voice row with `status: "previewing"` and its previews, and a
  `POST /api/custom-voices/{customVoiceId}/choose` with the chosen preview
  that saves it and moves the row to `ready`. Only the saved voice should use
  quota.
- **Deletes that free a slot.** Every vendor here except Google can delete a
  voice. The driver's `deleteVoice` runs on `DELETE /api/custom-voices/{id}`,
  and a deleted voice stops counting. A vendor with no delete call leaves out
  `deleteVoice`, and its deleted voices keep counting.
- **Consent.** Only OpenAI and Google check consent in the API. For every clip
  clone, whatever the vendor, the API should ask the caller to confirm they
  have the speaker's consent and store that with the row.
- **Per-account limits.** Ultravox (one clone) and xAI (Enterprise only) do
  not suit a shared platform account. They fit once an organisation can use
  its own vendor key.
