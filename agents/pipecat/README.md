# Aplisay Pipecat agent

Pipecat-based voice-agent worker that fulfils the same contract as the LiveKit
worker but is independent of LiveKit. The contract is documented in
[../../docs/livekit-agent-architecture.md](../../docs/livekit-agent-architecture.md);
this worker is one of two implementations that honour it.

## Architecture

Two transport surfaces, behind a single FastAPI process:

- **SIP / telephony** — terminates inbound and outbound SIP via a swappable
  `SipGateway`. The first implementation uses **Daily as a pure SIP gateway**:
  Daily receives the SIP INVITE (BYOC trunk via Daily's SIP endpoint, or a
  Daily-provisioned PSTN number) and bridges audio into a Daily room that the
  bot joins as `DailyTransport`. The `SipGateway` abstraction means a future
  FreeSWITCH-or-similar implementation can drop in without touching the call
  orchestration above it.
- **Browser / in-band WebRTC** — peer-to-peer via Pipecat's
  `SmallWebRTCTransport`. No third-party media server. The browser POSTs an SDP
  offer to `/webrtc/offer` with a signed join token issued by
  `Handler.join` in `lib/handlers/pipecat.js`; the worker validates the token,
  answers the offer, and runs the same agent pipeline as the SIP path.

The worker is mode-blind above the transport: tool dispatch, transfer state,
recording, and lifecycle / fallback handling are all gateway-agnostic.

## Endpoints

- `POST /dispatch` — outbound dispatch from the JS handler. Bearer-auth with
  `PIPECAT_DISPATCH_TOKEN`. Provisions a Daily SIP-enabled room, originates the
  outbound call, and runs the agent.
- `POST /webrtc/offer` — browser join entry. Validates the join token (HMAC
  SHA-256 with `PIPECAT_JOIN_SECRET`) and answers with a SmallWebRTC SDP.
- `POST /daily/dialin` — Daily's pinless dial-in webhook. Looks up the agent
  via the section-6 lookup chain and brings the bot into the room.

## Environment

Worker:

- `PIPECAT_DISPATCH_TOKEN` — shared bearer token between the JS handler and the
  worker.
- `PIPECAT_JOIN_SECRET` — HMAC secret used to sign / verify browser join
  tokens.
- `SERVICE_BASE_URI` — base URL of the llm-agent REST server.
- `SHARED_API_TOKEN` — value of the `x-shared-token` header for `agent-db`
  callbacks (section 8.1).
- `DAILY_API_KEY`, `DAILY_API_URL` — for the Daily `SipGateway` implementation.
- Provider keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
  `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY` (only those
  exercised by the configured models).

JS handler (`lib/handlers/pipecat.js`):

- `PIPECAT_WORKER_URL` — base URL of this worker.
- `PIPECAT_DISPATCH_TOKEN` — same value as the worker's.
- `PIPECAT_JOIN_SECRET` — same value as the worker's.
- `PIPECAT_PUBLIC_URL` — public origin clients use to reach the worker's
  `/webrtc/offer` endpoint.

## Running locally

```bash
cd agents/pipecat
uv sync
uv run python -m pipecat_aplisay
```

Expose `/daily/dialin` to Daily via ngrok (or equivalent) and configure your
Daily phone number's `room_creation_api` to point to it.

## Known contract gaps (vs section 6 of the architecture doc)

The Daily implementation hides parts of the SIP wire. Until either Daily exposes
them or we replace it with a self-operated SIP termination:

- Custom inbound SIP headers (`X-Aplisay-Trunk`, `X-Aplisay-PhoneRegistration`,
  `X-Lk-RealIp`, `X-Lk-Transport`) only land if Daily is configured to surface
  them in the dial-in webhook payload. The worker reads from `body.sip_headers`
  and degrades to the pure-number lookup path when missing.
- Outbound `X-Aplisay-Origin-Caller-Id` and `X-Aplisay-Call-Id` stamping uses
  Daily's `sipHeaders` parameter on `start_dialout`. Coverage depends on Daily
  honouring those headers on the wire.
- Transfer is blind only via Daily's `sip_call_transfer`. Consultative transfer
  (section 6.10) currently degrades to blind-bridge regardless of `canRefer` /
  `forceBridged`.

## Pipeline registry

Single source of truth for which model IDs run in pipeline mode:
[`pipecat_aplisay/pipeline_model_ids.py`](pipecat_aplisay/pipeline_model_ids.py).
The JS server reads the same set from `lib/models/pipecat.js`; keep the two in
sync until they're unified via a generated manifest.
