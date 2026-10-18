# Custom voices: implementation

How custom voices are built, operated and meant to grow. The developer guide,
with the API, is [../custom-voices.md](../custom-voices.md). Built in
llm-agent PRs #423 (API, Pipecat) and #424 (LiveKit).

## The create request

`POST /api/models/{modelName}/voices/{locale}` checks the input, takes a slot
from the quota and stores the voice as `creating`, then returns `202`. The
OpenAI call runs after that, in the background: `POST /v1/audio/voices` with
`type: "prompt"`, the `prompt`, `model: "auto"` and, when given,
`script_hint`. The name sent to OpenAI is `aplisay-<id>`, not the customer's
name. When OpenAI answers, the voice becomes `ready` with OpenAI's id in
`vendor_voice_id`. OpenAI returns no preview audio.

In two tests on 2026-10-18 OpenAI took 16 s and 21 s to make a voice.

A vendor refusal or failure is stored on the row as `status: "failed"` with
`error` and `error_code`: `rejected` when OpenAI answers `400` or `422`,
`vendor_unavailable` when it answers `429`, `vendor_error` for any other
failure, and `interrupted` from the settling step below. A timeout or network
failure is not marked failed, because OpenAI may still have made the voice.

## How the background create works

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

## How the workers speak a custom voice

The agent-db agent and instance reads, which both workers use, add a
`customVoice` block when `options.tts.voice` is one of the organisation's
ready voices and the agent's model can speak it:

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

Both workers then:

- send the voice in `session.start` as `session.audio.output.voice: { "id": "voice_123abc" }`
  (OpenAI takes a custom voice as an object and a stock voice as a string);
- add `Your speaking voice: <prompt>` to the voice model's instructions,
  between the language line and the delegation policy, as OpenAI asks for
  prompt voices;
- let `options.vendorSpecific.openai.live.audio.output.voice` win if an agent
  sets it;
- fall back to the default voice (`marin`) with a warning when
  `options.tts.voice` is a `voice_...` id with no `customVoice` block (deleted,
  or another organisation's), rather than have OpenAI refuse the session.

Pipecat (`agents/pipecat/pipecat_aplisay/gpt_live.py`) puts the voice object in
through its `session.start` merge, because upstream's settings take only a
name. LiveKit (`agents/livekit/lib/gpt-live.ts`) passes it to the plugin's
`GPTLiveModel` as `voice`, which accepts an object. A test on the LiveKit side
keeps the instruction text identical to the Python source.

The voice is fixed when the session starts. A handover to another GPT-Live
agent starts a new session with that agent's voice.

## Deleting at OpenAI

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


## Quota counting

`used` counts voices that are `creating` or `ready`, plus deleted voices of a
vendor with no delete call (none today: the driver's `deleteVoice` is what
frees a slot). Failed voices never count.

The quota check and the new row are written under one Postgres advisory lock,
so two requests cannot both take the last slot. The OpenAI call runs after
that, outside any transaction.

## The platform-wide cap

OpenAI allows **100 prompt voices per OpenAI organisation**, and Aplisay's
OpenAI organisation serves every customer. On top of the per-organisation
quota, the server refuses a new OpenAI prompt voice with `503`
(`code: "custom_voice_platform_limit"`) once the platform holds as many as
`OPENAI_PROMPT_VOICE_PLATFORM_LIMIT` (default 100). Deleted voices do not
count, on the basis that OpenAI's delete frees the slot. If it turns out not
to, OpenAI will refuse new voices before this cap is reached, and the API
passes OpenAI's error on.

## Platform setup

- `OPENAI_API_KEY` on the API server makes and deletes the voices. It must
  be a **project-scoped** key with the `api.voices.write` scope, on a project
  that OpenAI has approved for GPT-Live and custom voices.
- The Pipecat and LiveKit workers' `OPENAI_API_KEY` speaks with them. It must be a key of
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
| `error`, `error_code` | Why the vendor failed, and `rejected`, `vendor_unavailable`, `vendor_error` or `interrupted`. |
| `vendor_data` | The vendor's response, kept for audit. |
| `deleted_at` | When it was deleted. Rows are never destroyed. |

## Known gaps

- The builder's `list_voices` tool does not see custom voices yet.
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
