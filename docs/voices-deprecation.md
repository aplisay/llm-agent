# `/voices` deprecation and model-scoped voices

`GET /voices` is **deprecated**.

It returns a merged “global” voice catalogue that does **not** reliably match what a given model can actually use (especially for LiveKit **pipeline** vs **realtime** models).

Use the **model-scoped** voices endpoints instead.

## What to use instead

### 1) List locales for a model

Use this to populate the **language / locale** dropdown for a specific model:

- `GET /models/{modelName}/voices`

Notes:

- `modelName` must be **URL-encoded** as a *single path segment*.
  - Example: `livekit:openai/gpt-4o` → `livekit%3Aopenai%2Fgpt-4o`

Example:

```bash
curl -s "http://localhost:5000/api/models/livekit%3Aopenai%2Fgpt-4o/voices"
```

Response shape:

```json
{
  "locales": ["en-GB", "en-US"],
  "voiceStack": "realtime"
}
```

### 2) List voices for a model + locale (grouped by vendor)

Use this after the user chooses a locale, to populate the **voice** dropdown:

- `GET /models/{modelName}/voices/{locale}`

Example:

```bash
curl -s "http://localhost:5000/api/models/livekit%3Aopenai%2Fgpt-4o/voices/en-GB"
```

Response shape:

```json
{
  "vendors": {
    "openai": [
      { "name": "alloy", "gender": "unknown" }
    ]
  },
  "voiceStack": "realtime"
}
```

## Why this change was made

- **Correctness**: voice availability depends on the selected model and its execution mode.
  - LiveKit **realtime** voices are scoped to the realtime provider (OpenAI vs Ultravox, etc.).
  - LiveKit **pipeline** voices depend on configured STT/TTS providers and may intentionally omit catalogues that are not compatible (e.g. Google Cloud voice ids when the pipeline uses Gemini TTS).
- **Better UX**: the UI can show only the locales/voices that will work for the chosen model.

## Migration guidance

If you currently call `GET /voices`:

- Replace it with:
  - `GET /models/{modelName}/voices` to get `locales`
  - `GET /models/{modelName}/voices/{locale}` to get `vendors` and voice rows

Keep the selected `modelName` as the source of truth, and refresh locales/voices whenever the model changes.
