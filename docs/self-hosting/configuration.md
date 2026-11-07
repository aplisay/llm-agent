# Configuration reference

<!-- Generated from config/env.schema.json by `yarn env:generate`. Edit the schema, not this file. -->

Every component reads plain environment variables. The API server and the LiveKit worker also read a `.env` file from their working directory.
Start from [`environment-example`](../../environment-example): `cp environment-example .env`.

- A value written as `<...>` is treated as unset, and the server says so at start.
- `yarn doctor`, the start-up log and `GET /api/health` show which runtimes and providers are enabled, and which variables are missing for the rest.
- A runtime whose variables are unset is disabled, and its models are not listed in `GET /models`.

Components: **API** is the API server, **LiveKit** and **Pipecat** are the voice workers, **sipbridge** is the Pipecat SIP gateway.

## Core service

Listen port, logging and how the services find each other.

| Variable | Components | Default | Description |
|---|---|---|---|
| `WS_PORT` | API | `4000` | HTTP and WebSocket listen port. Wins over PORT when both are set. |
| `PORT` | API, Pipecat | `4000 (API), 8082 (Pipecat)` | Listen port when WS_PORT is unset. Container platforms such as Cloud Run set it. The Pipecat worker listens on it. |
| `LOGLEVEL` | API, LiveKit, Pipecat | `info (debug when NODE_ENV=development)` | Log level: fatal, error, warn, info, debug or trace. |
| `NODE_ENV` | API, LiveKit, Pipecat |  | Run mode: development (schema syncs at start, readable logs), production or staging (JSON logs). The yarn scripts set it. |
| `SERVICE_BASE_URI` | API, LiveKit, Pipecat |  | Base URL of the API server, without /api (for example http://localhost:4000), that the voice workers call back to. |
| `SHARED_API_TOKEN` | API, LiveKit, Pipecat |  | Token the voice workers send to the API as x-shared-token. It gives full access to every route, so use a long random value (openssl rand -hex 32). Needed when you run a worker. Secret. |
| `EXPOSE_PRIVATE_APIS` | API | `false` | Set to true to include the internal /agent-db routes in the published OpenAPI document. |
| `AGENT_TIMEZONE` | API, Pipecat | `Europe/London` | Time zone for the date and time an agent is given in its metadata. |

## Access and secrets

The first API key and encryption of stored secrets.

| Variable | Components | Default | Description |
|---|---|---|---|
| `BOOTSTRAP_API_KEY` | API |  | First API key for a new instance. On a database with no users the server creates one organisation, one superAdmin user and this key at start. Ignored once any user exists. 32 characters or more. Or leave it unset and run yarn bootstrap. Secret. |
| `CREDENTIALS_KEY` | API |  | Key that encrypts stored SIP passwords and agent key material. Unset means they are stored in plain text, with a warning. Set it in every real deployment (openssl rand -base64 32) and never change it once data exists. Secret. |
| `AUTHENTICATE_USERS` | API |  | Removed. If it is still set the server warns and ignores it: every request needs an API key. |
| `B2BUA_HEARTBEAT_TOKEN` | API |  | Token that B2BUA nodes may use, instead of SHARED_API_TOKEN, to report themselves to POST /api/agent-db/b2bua-nodes. Secret. |

## Database

PostgreSQL connection. The API server and the Jambonz worker connect directly.

| Variable | Components | Default | Description |
|---|---|---|---|
| `POSTGRES_HOST` | API |  | Database host. Required always. |
| `POSTGRES_PORT` | API |  | Database port. Required always. |
| `POSTGRES_DB` | API |  | Database name. Required always. |
| `POSTGRES_USER` | API |  | Database user. Required always. |
| `POSTGRES_PASSWORD` | API |  | Database password. Use letters and digits only: it is also placed in a connection URL without escaping. Secret. |
| `POSTGRES_CA` | API |  | CA certificate (inline PEM) for a TLS connection. Setting it turns TLS on. Secret. |
| `POSTGRES_CERT` | API |  | Client certificate (inline PEM) for mutual TLS. Secret. |
| `POSTGRES_KEY` | API |  | Client key (inline PEM) for mutual TLS. Secret. |
| `POSTGRES_RO_SERVER_NAME` | API |  | Server name the certificate is checked against when POSTGRES_HOST is an IP address. |
| `POSTGRES_POOL_MAX` | API | `5` | Connections per process. Each process opens up to this many plus one for notifications. |
| `POSTGRES_POOL_MIN` | API | `0` | Minimum idle connections per process. |
| `POSTGRES_POOL_ACQUIRE_MS` | API | `60000` | How long a query waits for a free connection. |
| `POSTGRES_POOL_IDLE_MS` | API | `10000` | How long an idle connection stays open. |
| `DB_FORCE_SYNC` | API | `false` | Forces a full schema sync at start. Development mode and an empty database sync without it. Read docs/running.md before you set it in production. |

## Model providers

Set at least one. A provider whose key is unset is not listed in GET /models.

| Variable | Components | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | API, LiveKit, Pipecat |  | OpenAI key: text models, and OpenAI Realtime and GPT-Live on the voice workers. Secret. |
| `ANTHROPIC_API_KEY` | API, Pipecat |  | Anthropic key: Claude text models. Secret. |
| `GOOGLE_API_KEY` | API, LiveKit |  | Google AI Studio key: Gemini text models, and Gemini Live on the LiveKit worker. Secret. |
| `GEMINI_API_KEY` | Pipecat |  | Gemini key for the Pipecat worker's Gemini Live and Gemini pipeline rows. Secret. |
| `GOOGLE_PROJECT_ID` | API |  | Google Cloud project for the Vertex AI Gemini driver. |
| `ULTRAVOX_API_KEY` | API, LiveKit, Pipecat |  | Ultravox key: the Ultravox runtime (no worker needed) and Ultravox rows on the voice workers. Secret. |
| `XAI_API_KEY` | API, Pipecat |  | xAI key: Grok text models and the Grok voice rows. Secret. |
| `GROK_API_KEY` | API |  | Older name for XAI_API_KEY, read when XAI_API_KEY is unset. Secret. |
| `DEEPSEEK_KEY` | API |  | DeepSeek key: DeepSeek text models. Secret. |
| `KIMI_KEY` | API |  | Moonshot key: Kimi text models. Secret. |
| `OPENROUTER_KEY` | API |  | OpenRouter key: OpenRouter text models. Secret. |
| `OPENROUTER_MODELS` | API |  | Extra OpenRouter model ids to list, comma separated. |
| `TYPESAFE_API_KEY` | API |  | TypeSafe key for the text:typesafe/ decision rows. With TYPESAFE_BASE_URL set to https://openrouter.ai/api, OPENROUTER_KEY is used instead. Secret. |
| `TYPESAFE_BASE_URL` | API | `https://api.typesafe.ai` | TypeSafe API base URL. |
| `TYPESAFE_TIMEOUT_MS` | API | `5000` | Time budget for one TypeSafe decision, including its one retry. |
| `ELEVENLABS_API_KEY` | API, LiveKit, Pipecat |  | ElevenLabs key: TTS on pipeline rows, ElevenLabs Agents rows, and the voice list. Secret. |
| `ELEVEN_API_KEY` | LiveKit |  | Older name for ELEVENLABS_API_KEY on the voice workers. Secret. |
| `ELEVENLABS_API_BASE` | LiveKit, Pipecat | `https://api.elevenlabs.io` | Regional ElevenLabs API endpoint. |
| `ELEVENLABS_AGENT_PREFIX` | LiveKit, Pipecat | `aplisay` | First part of the name of every ElevenLabs agent a worker creates, so deployments that share a workspace stay apart. |

## Speech providers

Speech-to-text and text-to-speech for pipeline (STT, LLM, TTS) rows. Speech-to-speech rows do not need them.

| Variable | Components | Default | Description |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | LiveKit, Pipecat |  | Deepgram key: speech-to-text on pipeline rows. Secret. |
| `CARTESIA_API_KEY` | API, LiveKit, Pipecat |  | Cartesia key: text-to-speech, and the voice list. Secret. |
| `NEUPHONIC_API_KEY` | API, LiveKit, Pipecat |  | Neuphonic key: text-to-speech, and the voice list. Secret. |
| `GOOGLE_APPLICATION_CREDENTIALS` | API, LiveKit, Pipecat |  | Path to a Google service account JSON file: Google speech, Vertex AI and GCS recording storage. |
| `GOOGLE_CREDENTIAL` | API, LiveKit, Pipecat |  | The Google service account JSON itself. At start the API and workers write it to the GOOGLE_APPLICATION_CREDENTIALS path if no file is there. Secret. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | API, LiveKit, Pipecat |  | Same as GOOGLE_CREDENTIAL, read when GOOGLE_CREDENTIAL is unset. Secret. |
| `GOOGLE_STT_LOCATION` | Pipecat | `global` | Google speech-to-text region on the Pipecat worker. |

## LiveKit runtime

LiveKit Cloud or a self-hosted LiveKit server. Unset means the livekit models are not listed.

| Variable | Components | Default | Description |
|---|---|---|---|
| `LIVEKIT_URL` | API, LiveKit |  | LiveKit server URL (wss://...). Browsers connect to it too, so it must be reachable from them. Required for the LiveKit runtime. |
| `LIVEKIT_API_KEY` | API, LiveKit |  | LiveKit API key. Required for the LiveKit runtime. Secret. |
| `LIVEKIT_API_SECRET` | API, LiveKit |  | LiveKit API secret. Required for the LiveKit runtime. Secret. |
| `LIVEKIT_SIP_OUTBOUND` | LiveKit |  | SIP address of the outbound trunk the LiveKit worker uses for transfers and outbound calls (host[:port]). |
| `LIVEKIT_SIP_USERNAME` | LiveKit |  | Digest user name for that outbound trunk. |
| `LIVEKIT_SIP_PASSWORD` | LiveKit |  | Digest password for that outbound trunk. Secret. |
| `NUM_IDLE_PROCESSES` | LiveKit | `10 in production, else 3` | Idle job processes the LiveKit worker keeps ready. |
| `DRAIN_TIMEOUT_MS` | LiveKit | `270000` | After SIGTERM, how long the LiveKit worker waits for calls to end before it exits. |
| `SETUP_FAILURE_CLEANUP_MS` | LiveKit | `15000` | How long the LiveKit worker keeps a room after call set-up fails, before it removes it. |
| `TRANSCRIPT_USER_TIME` | LiveKit, Pipecat |  | Set to arrival to time a caller's transcript row by when the text arrived rather than when speech started. |
| `GOOGLE_SECRETENV_PATH` | LiveKit, Pipecat |  | Google Secret Manager path (projects/<n>/secrets/<name>) the image reads a secretenv pair from at start. Optional. |
| `SECRETENV_FETCH_ATTEMPTS` | LiveKit | `3` | Attempts to read the secretenv pair from Secret Manager. |

## LiveKit pipeline defaults

Defaults for pipeline rows on the LiveKit worker.

| Variable | Components | Default | Description |
|---|---|---|---|
| `LIVEKIT_PIPELINE_USE_PROVIDER_KEYS` | LiveKit | `false` | true to run pipeline STT, LLM and TTS on your own provider keys instead of LiveKit Inference. |
| `LIVEKIT_PIPELINE_LLM` | LiveKit | `openai/gpt-4o-mini` | Default pipeline LLM. |
| `LIVEKIT_PIPELINE_STT` | LiveKit | `deepgram/nova-3:general` | Default pipeline STT. |
| `LIVEKIT_PIPELINE_STT_LANG` | LiveKit | `en` | Default STT language. |
| `LIVEKIT_PIPELINE_TTS` | LiveKit |  | Default pipeline TTS. |
| `LIVEKIT_PIPELINE_GOOGLE_TTS` | LiveKit |  | Google TTS voice for pipeline rows. |
| `LIVEKIT_PIPELINE_GEMINI_TTS_MODEL` | LiveKit | `gemini-2.5-flash-preview-tts` | Gemini TTS model. |
| `LIVEKIT_PIPELINE_GEMINI_TTS_VOICE` | LiveKit |  | Gemini TTS voice. |
| `LIVEKIT_PIPELINE_ELEVENLABS_MODEL` | LiveKit | `eleven_turbo_v2_5` | ElevenLabs TTS model on provider keys. |
| `LIVEKIT_PIPELINE_CARTESIA_TTS_MODEL` | LiveKit | `sonic-3` | Cartesia TTS model on provider keys. |
| `GOOGLE_GENAI_USE_VERTEXAI` | LiveKit | `false` | true to reach Gemini through Vertex AI on the LiveKit worker. |
| `GOOGLE_CLOUD_PROJECT` | LiveKit |  | Google Cloud project for Vertex AI on the LiveKit worker. |
| `GOOGLE_CLOUD_LOCATION` | LiveKit |  | Google Cloud region for Vertex AI on the LiveKit worker. |

## Pipecat runtime

The Pipecat worker. Unset means the pipecat models are not listed.

| Variable | Components | Default | Description |
|---|---|---|---|
| `PIPECAT_WORKER_URL` | API |  | URL the API dispatches Pipecat sessions to. Required for the Pipecat runtime. |
| `PIPECAT_DISPATCH_TOKEN` | API, Pipecat |  | Bearer token on dispatch calls. Same value on the API and the worker. Required for the Pipecat runtime. Secret. |
| `PIPECAT_JOIN_SECRET` | API, Pipecat |  | Secret that signs browser join requests. Same value on the API and the worker. Required for the Pipecat runtime. Secret. |
| `PIPECAT_PUBLIC_URL` | API |  | Public URL of the Pipecat worker that browsers connect to. Required for the Pipecat runtime. |
| `PIPECAT_SELF_IP` | Pipecat |  | This worker's own IP address, to tell its own WebRTC peers from others. |
| `WORKER_USER_ID` | Pipecat |  | User id the Pipecat worker writes on invocation log lines it cannot attribute. |
| `WORKER_ORGANISATION_ID` | Pipecat |  | Organisation id for those lines. |
| `HOST` | Pipecat | `0.0.0.0` | Address the Pipecat worker binds to. |
| `RELOAD` | Pipecat |  | Set to reload the Pipecat worker when its code changes (development). |
| `GRACEFUL_SHUTDOWN_SECONDS` | Pipecat | `15` | How long the Pipecat worker waits for calls to end at shutdown. |
| `HEALTHZ_MAX_SESSIONS` | Pipecat | `64` | Sessions above which the Pipecat health check fails. |
| `HEALTHZ_MAX_THREADS` | Pipecat | `400` | Threads above which the Pipecat health check fails. |
| `HEALTHZ_MAX_GATEWAY_ENTRIES` | Pipecat | `512` | Gateway entries above which the Pipecat health check fails. |
| `HEALTHZ_MAX_TASKS` | Pipecat | `256` | Tasks above which the Pipecat health check fails. |

## Pipecat SIP gateways

How the Pipecat worker reaches the phone network.

| Variable | Components | Default | Description |
|---|---|---|---|
| `SIP_GATEWAY` | Pipecat |  | Telephony gateway: sipbridge, freeswitch, voiceblender or daily. |
| `PIPECAT_SIP_OUTBOUND` | Pipecat |  | Outbound SBC for calls the sipbridge gateway places: host[:port][;transport=tls\|tcp\|udp]. |
| `PIPECAT_SIP_USERNAME` | Pipecat, sipbridge |  | Digest user name the gateway presents to the outbound SBC. |
| `PIPECAT_SIP_PASSWORD` | Pipecat, sipbridge |  | Digest password for the outbound SBC. Secret. |
| `PIPECAT_SIP_FROM_DOMAIN` | Pipecat, sipbridge |  | Domain in the From header of outbound INVITEs. |
| `SIPBRIDGE_BASE_URL` | Pipecat |  | REST URL of the sipbridge the worker controls. |
| `SIPBRIDGE_API_TOKEN` | Pipecat, sipbridge |  | Bearer token on sipbridge REST calls. Same value on the worker and sipbridge. Secret. |
| `ESL_POLLER_URL` | Pipecat | `http://esl-poller:4001` | URL of the FreeSWITCH esl-poller. |
| `ESL_POLLER_TOKEN` | Pipecat |  | Token for the esl-poller. Falls back to CALL_API_TOKEN. Secret. |
| `CALL_API_TOKEN` | Pipecat |  | Shared token for the FreeSWITCH call API and worker events. Secret. |
| `WORKER_EVENT_TOKEN` | Pipecat |  | Token on events the gateway sends to the worker. Falls back to CALL_API_TOKEN. Secret. |
| `VOICEBLENDER_BASE_URL` | Pipecat | `http://voiceblender:8080` | Voiceblender REST URL. |
| `VOICEBLENDER_API_KEY` | Pipecat |  | Voiceblender API key. Secret. |
| `VOICEBLENDER_APP_ID` | Pipecat | `aplisay-pipecat` | Voiceblender application id. |
| `VOICEBLENDER_WORKER_WS_BASE` | Pipecat | `ws://pipecat-worker:8082` | WebSocket base URL Voiceblender uses to reach the worker. |
| `VOICEBLENDER_VSI_TOKEN` | Pipecat |  | Token for the Voiceblender event subscription. Falls back to VOICEBLENDER_API_KEY. Secret. |
| `DAILY_API_KEY` | Pipecat |  | Daily API key (SIP_GATEWAY=daily). Secret. |
| `DAILY_API_URL` | Pipecat | `https://api.daily.co/v1` | Daily API URL. |

## Pipecat WebRTC tuning

Browser sessions on the Pipecat worker. The defaults suit most installs.

| Variable | Components | Default | Description |
|---|---|---|---|
| `WEBRTC_ICE_SERVERS` | Pipecat |  | STUN and TURN URLs, comma separated. Empty disables them. |
| `WEBRTC_ALLOWED_ORIGINS` | Pipecat |  | Browser origins allowed to open a session, comma separated. |
| `WEBRTC_PEER_HOST` | Pipecat |  | Host name that resolves to every worker, used to route a browser's follow-up requests to the worker that owns its session. |
| `WEBRTC_PEER_PORT` | Pipecat | `8082` | Port of the other workers. |
| `WEBRTC_PEER_DNS_TTL_S` | Pipecat |  | How long a peer lookup is cached. |
| `WEBRTC_PEER_TIMEOUT_S` | Pipecat | `1.5` | Timeout for a request to a peer worker. |
| `WEBRTC_OUTPUT_CUSHION_MS` | Pipecat |  | Audio buffered before playback starts. |
| `WEBRTC_OUTPUT_TARGET_MS` | Pipecat |  | Target playback buffer. |
| `WEBRTC_OUTPUT_MAX_MS` | Pipecat |  | Largest playback buffer before audio is trimmed. |
| `WEBRTC_STRETCH_QUIET_DBFS` | Pipecat |  | Level below which audio counts as quiet for stretching. |
| `WEBRTC_STRETCH_EVERY` | Pipecat |  | How often a quiet frame may be stretched. |
| `WEBRTC_TRIM_EVERY` | Pipecat |  | How often a frame may be trimmed. |
| `WEBRTC_UNDERRUN_LOG_MS` | Pipecat |  | Gap size from which playback underruns are logged. |
| `WEBRTC_UNDERRUN_STATS` | Pipecat |  | Set to 0 to turn off underrun counting. |
| `WS_TRACE` | Pipecat |  | Set to 1 to log every WebSocket frame. |

## sipbridge

The Go SIP gateway beside the Pipecat worker.

| Variable | Components | Default | Description |
|---|---|---|---|
| `SIPBRIDGE_SIP_SIGNAL_IP` | sipbridge |  | Public IP address sipbridge puts in SIP headers. |
| `SIPBRIDGE_SIP_SIGNAL_PORT` | sipbridge | `5060` | SIP port. |
| `SIPBRIDGE_SIP_BIND_IP` | sipbridge |  | Local address for SIP. |
| `SIPBRIDGE_SIP_UDP_DISABLED` | sipbridge | `false` | true to turn off SIP over UDP. |
| `SIPBRIDGE_SIP_TLS_PORT` | sipbridge | `5061` | SIP over TLS port. |
| `SIPBRIDGE_TLS_CERT_FILE` | sipbridge |  | TLS certificate file. |
| `SIPBRIDGE_TLS_KEY_FILE` | sipbridge |  | TLS key file. Secret. |
| `SIPBRIDGE_TLS_AUTO_SELFSIGNED` | sipbridge | `true` | Make a self-signed certificate when no files are given. |
| `SIPBRIDGE_SRTP_ENABLED` | sipbridge | `true` | Offer SRTP. |
| `SIPBRIDGE_SRTP_REQUIRED` | sipbridge | `false` | Refuse calls without SRTP. |
| `SIPBRIDGE_SRTP_DTLS_ENABLED` | sipbridge | `true` | Allow DTLS-SRTP. |
| `SIPBRIDGE_SRTP_OUTBOUND` | sipbridge | `true` | Offer SRTP on outbound calls. |
| `SIPBRIDGE_MEDIA_IP` | sipbridge |  | Public IP address for RTP. |
| `SIPBRIDGE_MEDIA_BIND_IP` | sipbridge |  | Local address for RTP. |
| `SIPBRIDGE_RTP_PORT_MIN` | sipbridge | `10000` | Lowest RTP port. |
| `SIPBRIDGE_RTP_PORT_MAX` | sipbridge | `20000` | Highest RTP port. |
| `SIPBRIDGE_RTP_TIMEOUT_SECONDS` | sipbridge | `10` | Seconds without RTP before a call is ended. |
| `SIPBRIDGE_RTP_SILENCE_FILL` | sipbridge | `true` | Send silence when the worker sends no audio. |
| `SIPBRIDGE_WORKER_WS_BASE` | sipbridge | `ws://pipecat-worker:8082` | WebSocket base URL of the Pipecat worker. |
| `SIPBRIDGE_API_BIND_ADDR` | sipbridge | `:8090` | REST API listen address. |
| `SIPBRIDGE_LOG_LEVEL` | sipbridge | `info` | Log level. |
| `SIPBRIDGE_SIP_TRACE` | sipbridge | `false` | Log every SIP message. |

## Jambonz runtime

An external Jambonz cluster for SIP calls. Unset means the jambonz models are not listed.

| Variable | Components | Default | Description |
|---|---|---|---|
| `JAMBONZ_SERVER` | API |  | Jambonz API host name. Required for the Jambonz runtime. |
| `JAMBONZ_API_KEY` | API |  | Jambonz API key. Required for the Jambonz runtime. Secret. |
| `JAMBONZ_AGENT_NAME` | API |  | Public DNS name of the Jambonz worker that Jambonz calls back to. |

## Telephony and SIP

Phone numbers, trunks and SIP registrations.

| Variable | Components | Default | Description |
|---|---|---|---|
| `APLISAY_OUTBOUND_TRUNK_ID` | API, LiveKit, Pipecat |  | Trunk id that outbound and carried legs leave on, for billing and outbound call authorisation. Set the same value on the API and both workers. |
| `REGSERVER_REGISTRAR` | API |  | Host name customers' PBXes register to. Unset means registrar accounts cannot be created. Permanent once the first account exists. |
| `REGCLIENT_API_TOKEN` | API |  | Token for the B2BUA node API (SIP traces and registration probes). Unset turns those routes off (503). Secret. |
| `REGCLIENT_API_TOKEN_PREVIOUS` | API |  | The previous token, accepted while a new one rolls out. Secret. |
| `REGCLIENT_API_PORT` | API | `8443` | B2BUA node API port. |
| `REGCLIENT_API_SCHEME` | API | `https` | B2BUA node API scheme. |
| `REGCLIENT_CA_CERT` | API |  | CA certificate (PEM or base64 PEM) that signs node certificates. |
| `REGCLIENT_API_INSECURE` | API | `0` | Development only: skip TLS checks on the node API. |
| `REGCLIENT_DISCOVERY_TIMEOUT_MS` | API | `750` | Time limit for the first request to an unknown node. |
| `REGCLIENT_CAPABILITY_TTL_MS` | API | `600000` | How long a node's support for traces is remembered. |
| `REGCLIENT_UNSUPPORTED_TTL_MS` | API | `60000` | How long a node's lack of support is remembered. |
| `REGCLIENT_PROBE_NODES` | API |  | Nodes that may probe a registration no node has claimed. |
| `REGCLIENT_NODE_ALLOWLIST` | API |  | Only these node addresses may be contacted. |
| `REGCLIENT_ALLOW_PRIVATE_NODES` | API | `0` | Allow node addresses in private ranges. |
| `REGCLIENT_USE_PRIVATE_NODE_ADDRESS` | API |  | Reach nodes on their private address. |
| `TRACE_PROXY_TIMEOUT_MS` | API | `2000` | Time limit for a trace request to a node. |
| `REG_SIM_ENABLED` | API | `false` | true to turn on the registration simulator (testing). |

## Recording and stored audio

Where call recordings and cached fallback messages are kept.

| Variable | Components | Default | Description |
|---|---|---|---|
| `RECORDING_STORAGE_PATH` | API, LiveKit, Pipecat |  | Where call recordings go: gs://bucket/prefix (Google Cloud Storage). |
| `FALLBACK_MESSAGE_STORAGE_PATH` | API, Pipecat |  | Where cached fallback messages go: gs://bucket/prefix. Defaults to a folder beside the recordings. |

## Hosted sign-up and email

User sign-up with better-auth, the waitlist and outbound email. Only needed beside a front end such as polite.ai. Off unless BETTER_AUTH_ENABLED=true. Run yarn auth:migrate once to create better-auth's own tables.

| Variable | Components | Default | Description |
|---|---|---|---|
| `BETTER_AUTH_ENABLED` | API | `false` | true to turn on better-auth user sign-in beside API keys. |
| `BETTER_AUTH_SECRET` | API |  | Random secret of 32 characters or more. Required when BETTER_AUTH_ENABLED=true. Secret. |
| `BETTER_AUTH_URL` | API | `http://localhost:<port>` | Public base URL of this API, used to build OAuth callback URLs. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | API |  | Front-end origins allowed to call the auth routes, comma separated. |
| `BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION` | API | `false` | true to require a verified email address before sign-in. |
| `BETTER_AUTH_GOOGLE_CLIENT_ID` | API |  | Google OAuth client id for Google sign-in. |
| `BETTER_AUTH_GOOGLE_CLIENT_SECRET` | API |  | Google OAuth client secret. Secret. |
| `AUTH_PROXY_SECRET` | API |  | Secret a proxying front end sends to have its end user's IP address trusted for rate limits. Secret. |
| `AUTH_EMAIL_PER_ADDRESS_HOURLY` | API | `3` | Emails per address per hour from the reset and verification routes. |
| `AUTH_EMAIL_PER_ADDRESS_DAILY` | API | `10` | Emails per address per day. |
| `AUTH_EMAIL_GLOBAL_HOURLY` | API | `250` | Emails per hour in total. |
| `WAITLIST_CALLBACK_URL` | API |  | Where the waitlist confirmation link sends the user. |
| `POLITE_SITE_URL` | API |  | Origin of the front end that receives Google sign-in hand-offs. |
| `ADMIN_USER_IDS` | API |  | User ids allowed to call the admin /api/users routes, comma separated. |
| `EMAIL_SEND_TYPE` | API |  | smtp2go to send email. Unset means emails are written to the log. |
| `EMAIL_SEND_KEY` | API |  | SMTP2GO API key. Secret. |
| `EMAIL_SEND_URL` | API |  | Override for the SMTP2GO send endpoint. |
| `EMAIL_FROM_ADDRESS` | API |  | Sender address. |
| `EMAIL_FROM_NAME` | API |  | Sender name. |
| `EMAIL_BRANDS` | API |  | Sender personas as inline JSON (lib/auth/email-brands.js). |
| `EMAIL_BRANDS_FILE` | API |  | Path to a JSON file of sender personas. |

## Tuning

Limits and timeouts. The defaults suit most installs.

| Variable | Components | Default | Description |
|---|---|---|---|
| `CALL_LOG_RATE_LIMIT` | API | `60` | Requests per principal per window to the call log routes. |
| `CALL_LOG_RATE_WINDOW_MS` | API | `60000` | Window for that limit. |
| `CALL_LOG_MAX_CONCURRENT` | API | `2` | Call log reads in flight per process. Kept below POSTGRES_POOL_MAX. |
| `CALL_LOG_QUEUE_WAIT_MS` | API | `2000` | How long a call log read waits for a slot before 503. |
| `CALL_LOG_QUEUE_MAX` | API | `8` | Call log reads that may wait. |
| `AGENT_CONCURRENCY_STORE` | API | `sql` | Store for concurrency counters. Keep sql. |
| `ANTHROPIC_MAX_RETRIES` | API | `1` | Anthropic SDK retry count. |
| `ANTHROPIC_REQUEST_TIMEOUT_MS` | API |  | Anthropic request timeout. |
| `ANTHROPIC_CACHE_TTL` | API | `1h` | Prompt cache lifetime for Anthropic: 5m or 1h. |
| `OPENAI_TIMEOUT_MS` | API | `900000` | OpenAI request timeout. |
| `OPENAI_COMPAT_TIMEOUT_MS` | API | `300000` | Timeout for OpenAI-compatible providers (DeepSeek, Kimi, OpenRouter, xAI). |
| `SUBAGENT_TIMEOUT` | API | `60000` | Time limit for a subagent or agent invoke. |
| `SET_BUILDER_MODEL` | API |  | Model the agent-set builder uses. |
| `SET_BUILDER_MCP_URL` | API |  | MCP server the agent-set builder uses. |
| `SET_BUILDER_MAX_TOKENS` | API | `32768` | Output token limit for the builder. |
| `TEXT_CHAT_MAX_TOOL_HOPS` | API | `16` | Tool call rounds allowed in one text chat turn. |
| `TEXT_CHAT_HANDOFF_WAIT_MS` | API | `5000` | How long a process waits for another to hand over a chat session. |
| `TEXT_CHAT_HANDOFF_BUSY_WAIT_MS` | API | `90000` | The same wait when the owner is busy with a turn. |
| `TEXT_CHAT_STATE_MAX_BYTES` | API | `4194304` | Largest chat state saved for another process to resume. |
| `TEXT_CHAT_REATTACH_GRACE_MS` | API | `900000` | How long a disconnected chat session can be resumed. |
| `TEXT_CHAT_HEARTBEAT_MS` | API | `60000` | How often a process marks its chat sessions as alive. |
| `TEXT_CHAT_LIVENESS_GRACE_MS` | API | `300000` | Missed heartbeat time after which another process may take a session. |
| `USAGE_STALE_SESSION_HOURS` | API | `24` | Age after which an unfinished usage session is closed. |

## Diagnostics

Off unless set.

| Variable | Components | Default | Description |
|---|---|---|---|
| `RUNTIME_STATS_MS` | LiveKit |  | Interval for event loop and CPU samples on the LiveKit worker. |
| `PROFILE_MS` | LiveKit | `0` | Length of a CPU profile window on the LiveKit worker. |
| `PROFILE_DIR` | LiveKit | `/prof` | Where CPU profiles are written. |
| `PROFILE_INTERVAL_US` | LiveKit | `1000` | CPU profile sampling interval. |
| `PROFILE_ROLE` | LiveKit | `all` | Which processes to profile: all, supervisor or job. |
| `PROFILE_ON_EXIT` | LiveKit |  | Set to 1 to write a profile when a process exits. |
| `PROFILE_SIGNAL` | LiveKit |  | Set to 1 to start and stop profiles with SIGUSR2. |

## Set by the platform or the image

You do not normally set these.

| Variable | Components | Default | Description |
|---|---|---|---|
| `BUILD_COMMIT` | API, Pipecat |  | Commit the image was built from. Set by the image build. |
| `BUILD_BRANCH` | API, Pipecat |  | Branch the image was built from. Set by the image build. |
| `BUILD_TAG` | API, Pipecat |  | Tag the image was built from. Set by the image build. |
| `LIVEKIT_WORKER_PREBUILT` | API |  | Set by the API image: the LiveKit registry is already built, so prestart skips the build. |
| `HOSTNAME` | API |  | Host name, used to name this process in the database. |
| `POD_NAME` | API |  | Kubernetes pod name, used in place of HOSTNAME. |
| `TMPDIR` | LiveKit |  | Temporary directory. |
| `SECRETENV_KEY` | API, LiveKit, Pipecat, sipbridge |  | Key for SECRETENV_BUNDLE. Optional: see docs/running.md. Secret. |
| `SECRETENV_BUNDLE` | API, LiveKit, Pipecat, sipbridge |  | The whole environment, encrypted. Optional. Secret. |
