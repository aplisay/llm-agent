# Bring Your Own Key (BYOK)

Organisation-level provider API keys that are used **in preference to** the
platform's own keys wherever the platform would otherwise spend its own
credential on that organisation's traffic: ultravox, livekit and pipecat
realtime and pipeline voice agents, and text-based agents (interactive chat,
one-shot invoke, and in-call subagents/summarisers, which all execute in the
main server process).

## Principles

1. **Encrypted at rest, fail-closed.** Key values are AES-256-GCM encrypted
   with the existing `CREDENTIALS_KEY` secret (`lib/utils/credentials.js`).
   Unlike the legacy warn-and-store-plaintext behaviour used for SIP
   passwords, BYOK writes are *refused* (500) when `CREDENTIALS_KEY` is not
   configured, and a stored value that fails to decrypt fails the call rather
   than silently falling back.
2. **Need-to-know distribution, per call.** Decryption happens only in the
   main server process. Workers receive decrypted keys only inside the
   per-call config document they already fetch over the internal
   `x-shared-token` agent-db API, filtered down to the providers that call
   can actually use. Nothing is cached worker-side, so rotation/revocation
   takes effect on the next call. Keys never enter LiveKit dispatch/room/
   participant metadata, pipecat dispatch payloads, join tokens, transaction
   logs, or invocation logs.
3. **Org key wins, no silent fallback.** If the organisation has a key for
   the provider in use, that key is used. If it is invalid or unreadable the
   session fails with a clear error; the platform key is *not* silently
   substituted (that would burn platform credit while the org believes its
   key is in use). If the organisation has no key for a provider, platform
   behaviour is unchanged.
4. **v1 does not extend the model roster.** BYOK overrides credentials for
   models the platform already offers (`GET /api/models` is unchanged).
   BYOK-only model availability needs the static `canLoad` roster reworked
   and is deferred.

## Out of scope for v1

- **jambonz family** (`jambonz:` models): untouched entirely, LLM included.
  Note the *ultravox* family remains fully in scope even on telephony: the
  Ultravox handler resolves its own org key inside `join()`/`destroy()`/
  `callEnded()` (a direct `OrganisationKey` DB lookup), so it behaves
  identically whether it executes in the main server (WebRTC) or inside the
  jambonz bridge process (telephony) without touching jambonz-family code.
- **Service-account-JSON credentials**: Google BYOK covers Gemini
  API-key auth (LLM + realtime). Google pipeline STT/TTS (service-account /
  ADC / Vertex auth) stays on platform credentials.
- **LiveKit Inference components**: pipeline components with no org key keep
  today's behaviour (LiveKit Inference or worker env). A component whose
  provider *has* an org key is built as a direct provider plugin instead.
- **Voice-catalogue browsing** (`GET /voices`) stays on platform keys.
- **Automatic billing zero-rating.** Pricing remains the per-org rate-card
  mechanism. The workers stamp `metadata.aplisay.byokProviders` on calls that
  used org keys (informational, best-effort) so billing can distinguish BYOK
  traffic later.
- Built-in platform agents (`builtin:set-builder`) keep platform keys.

## Provider registry

`lib/utils/provider-keys.js` is the single source of truth. Keys are stored
by **canonical provider slug**, never by env-var name (the same provider has
different env names across runtimes).

| slug | label | dimensions | used by |
|---|---|---|---|
| `openai` | OpenAI | llm, realtime | text/pipecat/livekit LLM + realtime |
| `anthropic` | Anthropic | llm | text + pipecat pipeline LLM |
| `google` | Google (Gemini API key) | llm, realtime | text/pipecat/livekit Gemini |
| `ultravox` | Ultravox | realtime | ultravox: family, livekit:/pipecat: ultravox models |
| `deepgram` | Deepgram | stt, tts | pipeline STT/TTS (livekit + pipecat) |
| `elevenlabs` | ElevenLabs | tts | pipeline TTS (livekit + pipecat) |
| `cartesia` | Cartesia | tts | pipeline TTS (livekit + pipecat) |
| `kimi` | Kimi (Moonshot) | llm | text: |
| `openrouter` | OpenRouter | llm | text: |
| `deepseek` | DeepSeek | llm | text: |

Model-string provider segments map to slugs case-insensitively:
`openai→openai`, `anthropic→anthropic`, `google|gemini→google`,
`ultravox|fixie-ai→ultravox`, `kimi|moonshot→kimi`, `openrouter→openrouter`,
`deepseek→deepseek`. `options.stt.vendor` maps `deepgram→deepgram` (other
STT vendors are not BYOK-injectable in v1); `options.tts.vendor` maps
`elevenlabs`, `cartesia`, `deepgram` to themselves (`google` TTS excluded —
SA auth).

## Storage

New table `organisation_keys`, model `OrganisationKey` in
`lib/database-models/organisation-key.js` (PhoneRegistration pattern),
registered from `lib/database.js`; schemaVersion 58 → 59.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | `DataTypes.UUID`, default UUIDV4 |
| `organisationId` | STRING FK → organisations.id | CASCADE on delete |
| `provider` | STRING | canonical slug; **unique per organisation** (composite unique index with organisationId) |
| `value` | TEXT | encrypted via strict (fail-closed) `encryptSecret`; transparent decrypt getter; `enc:` idempotency guard on set |
| `hint` | STRING(8) | last 4 chars of the plaintext, stored separately at write time so listings never touch `value` |

`lib/utils/credentials.js` gains `encryptSecretStrict(plainText)` which
throws when `CREDENTIALS_KEY` is unset or the cipher fails (never returns
plaintext). `decryptSecret` is unchanged.

The sync chain adds `OrganisationKey.sync({ alter: true })` immediately
after `Organisation.sync` in the versioned upgrade, **plus** an
unconditional plain `OrganisationKey.sync()` beside the `ChatSession.sync()`
hardening call (gated new-table creation has silently missed environments
twice before).

## API

Admin-style org subresource, tagged `Organisations`. All routes gate on the
new `organisation:providerKeys` RBAC action then `targetInScope(user,
'organisation', org)` (own org for owner/orgAdmin; any org for superAdmin;
out-of-scope is 404, not 403). `providerKeys` is granted to
owner/textOnly/audioOnly (via `OWNER_STATEMENTS`), orgAdmin and superAdmin —
not member.

```
GET    /api/organisations/{organisationId}/provider-keys
  200 { items:     [{ provider, hint, updatedAt }],
        providers: [{ id, label, dimensions }] }   # registry catalogue for UIs
  # values are write-only and never returned

PUT    /api/organisations/{organisationId}/provider-keys/{provider}
  body { value: "sk-..." }        # non-empty string
  200 { provider, hint }          # upsert (insert or replace)
  400 unknown provider slug / invalid body
  500 { message } when CREDENTIALS_KEY is unavailable (fail-closed, nothing stored)

DELETE /api/organisations/{organisationId}/provider-keys/{provider}
  204                             # platform keys apply again from the next call
  404 no such stored key
```

## Distribution

### Server-side resolution — `lib/org-keys.js`

- `providersForAgent(agent)` → `Set<slug>` — the need-to-know filter:
  providers referenced by `agent.modelName`, `agent.options.stt.vendor`,
  `agent.options.tts.vendor` and `agent.options.fallback.model`. Because the
  workers resolve vendor defaults the agent row does not record (STT defaults
  to deepgram on both workers; TTS is defaulted or inferred from the voice per
  worker; bridged-transfer transcription taps build STT even for realtime
  models), an UNSET vendor on a livekit/pipecat agent ships every key the
  worker's own defaulting could consume (deepgram for STT;
  cartesia/elevenlabs/deepgram for TTS) — only an explicit vendor narrows the
  set. Model-scoped vendor strings (`deepgram/nova-3`) resolve by their
  prefix. jambonz-family agents ship nothing (out of scope).
- `resolveOrganisationKeys(organisationId, providers)` →
  `{ [slug]: value|null }` — decrypted values for the stored subset of
  `providers`. Providers with no stored key are **omitted**; a stored key
  that fails to decrypt is present with value `null` (consumers must treat
  `null` as fatal for that provider — fail-closed, no env fallback).

### Wire shape (internal agent-db API only)

`GET /api/agent-db/instance` and `GET /api/agent-db/agent` responses gain a
top-level `organisationKeys` object (omitted when empty):

```json
{ "...": "...", "Agent": { "...": "..." }, "organisationKeys": { "openai": "sk-..." } }
```

(for `/agent-db/agent` the object is a property of the returned agent JSON).
These endpoints are already `x-shared-token`-only and hidden from public
Swagger. The public API never carries `organisationKeys` anywhere.

### Workers

- **pipecat** (`voice_session.py`): a `_resolve_provider_key(org_keys,
  slug, *env_names)` helper — org key wins; `null`/empty org entry raises a
  clear `ByokKeyError`; absent slug falls through to `_require_env`.
  Applied at every service construction site: `_build_realtime`
  (openai/google/ultravox), `_build_pipeline` LLM
  (openai/google/anthropic), `build_stt_service` (deepgram),
  `build_tts_service` (cartesia/elevenlabs/deepgram). Handover
  (`transfer_agent`) and fallback paths re-fetch and re-resolve naturally.
- **livekit** (`voice-session-factory.ts` + `pipeline-provider-keys.ts`):
  the fetched doc's `organisationKeys` is threaded into
  `createVoiceModelAndSession`. Realtime: `llmOptions.apiKey` set from the
  org key when present (openai / google / vendored ultravox plugins all
  accept it). Pipeline: a component whose provider has an org key is built
  as a direct provider plugin with an explicit `apiKey`
  (deepgram/elevenlabs/cartesia/openai/google); components without org keys
  keep existing behaviour. Both the initial session and the transfer/
  fallback re-construction sites are covered.
- **Fallback agents**: both workers fetch `options.fallback.agent` through
  the internal agent-db route (with `expectedOrganisationId`) rather than the
  public agent GET, so the fallback agent's own `organisationKeys` bag
  applies to the rebuilt session.
- **text agents (Node)**: `lib/text-chat.js buildLlm()` and
  `lib/subagent.js runSubagent()` resolve the model's provider key via
  `lib/org-keys.js` and pass an `apiKey` constructor override. Drivers:
  `openai.js`, `gemini.js`, `openai-compatible.js` accept `apiKey`
  (per-instance clients already); `anthropic.js` constructs a per-instance
  SDK client only when an override is present (platform traffic keeps the
  module singleton and its prompt-cache behaviour); the fail-closed
  missing-key throw in `openai-compatible.js` is preserved (an org key for
  the *wrong* provider must never fall through to `OPENAI_API_KEY`).
- **ultravox voice** (`lib/handlers/ultravox.js` + `lib/models/ultravox.js`):
  `join()` resolves the org's `ultravox` key (direct `OrganisationKey`
  lookup by `agent.organisationId`) and, when present, uses a per-call
  axios client for `POST calls` / `DELETE calls/{id}` /
  `GET calls/{id}/messages` instead of the module-frozen client. Works
  identically in the main server and the jambonz bridge process (both have
  DB access and `CREDENTIALS_KEY`).

### Redaction

`organisationKeys` must never be logged: both workers and the server strip
it from any debug/invocation-log dump of the agent/instance document, and it
is excluded from transfer-agent dicts except where service construction
needs it. BYOK keys are delivered only as constructor arguments, never
through anything that reaches `messageHandler`/transaction logs.
Mechanisms: the LiveKit worker re-attaches the bag NON-ENUMERABLY to fetched
docs (spreads/`JSON.stringify` drop it); the pipecat worker pops it off the
agent dict into separate (`repr=False`) fields at every entry point and runs
loguru with `diagnose=False` so traceback frames cannot render local
variables; the Ultravox handler logs Axios failures under pino's `err`
serializer only (a raw AxiosError key would emit the `X-API-Key` request
header via `toJSON()`).

## Deployment

- Schema bump ⇒ one boot with `DB_FORCE_SYNC=true` per environment.
- `CREDENTIALS_KEY` must be set (already on the production checklist) or all
  BYOK writes are refused.
- Worker images (livekit, pipecat) must be rolled to pick up the injection
  code; no new worker env vars are required.
