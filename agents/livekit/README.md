# LiveKit Agent

A modular LiveKit voice agent implementation with SIP telephony support.

## Structure

The agent has been refactored into a modular structure:

- `realtime.ts` - Main entry point
- `lib/` - Core modules
  - `index.ts` - Module entry point and CLI runner
  - `worker.ts` - Main agent worker logic
  - `telephony.ts` - SIP transfer and bridging functions
  - `initialise.ts` - SIP client initialization

## Installation

```bash
yarn install
```

## Building

```bash
yarn build
```

This will compile TypeScript files to JavaScript in the `dist/` directory.

## Usage

### Running the Agent

```bash
# Development mode
yarn develop

# Production mode
yarn start

# Staging mode
yarn stage
```

### Setup SIP Configuration

This configures LiveKit SIP trunks and dispatch rules. From a local checkout, with a
`.env` alongside:

```bash
node dist/realtime.js setup
```

Inside a container, run it **through the image entrypoint** instead:

```bash
docker compose run --rm livekit-agent setup
```

`dotenv` is aliased to secretenv, so `LIVEKIT_*` and everything else are decrypted out
of `SECRETENV_BUNDLE` — and only `entrypoint.sh` puts that pair in the environment
(see [deploy/gcp/README.md](deploy/gcp/README.md)). Those exports live in PID 1 alone;
`docker exec` builds its environment from the image and compose config, so a bare
`docker exec … node dist/realtime.js setup` runs with no credentials at all. To use an
already-running container rather than a fresh one, invoke the entrypoint explicitly:

```bash
docker exec <container> /bin/sh /usr/src/app/entrypoint.sh setup
```

### Programmatic Usage

```javascript
import { runSetup } from './lib/initialise.js';
import { transferParticipant, bridgeParticipant } from './lib/telephony.js';
import worker from './lib/worker.js';

// Setup SIP clients
await runSetup();

// Use telephony functions
await transferParticipant(roomName, participant, transferTo, aplisayId, null, null, callerId, callId);
await bridgeParticipant(roomName, bridgeTo, aplisayId, callerId, originCallerId, false, null, null, null, callId);

// Use the worker
export default worker;
```

## Environment Variables

Required environment variables:

- `LIVEKIT_URL` - LiveKit server URL
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret
- `LIVEKIT_SIP_OUTBOUND` - SIP outbound configuration
- `LIVEKIT_SIP_USERNAME` - SIP username
- `LIVEKIT_SIP_PASSWORD` - SIP password
- `SERVICE_BASE_URI` - Base URL for internal API calls (worker → agent-db)
- `SHARED_API_TOKEN` - Optional auth for internal API calls

Registration-based **outbound originate** (caller ID = registration UUID) has no inbound SIP leg, so the worker uses the registration row’s **`b2buaId`** (B2BUA gateway IP/hostname — same value as `sipHXLkRealIp` on inbound registration calls) and **`options.transport`** (default `tcp`) for `findOrCreateRegistrationTrunk`, instead of reading participant attributes.

## Development

```bash
# Watch mode for development
yarn dev
```

## Deployment

The agent runs as a single container on GCE VMs. Deployment tooling —
docker-compose template, per-environment env templates, a bare-host deploy
script and the secretenv bundler — lives in [`deploy/gcp/`](deploy/gcp), and
follows the same structure as `aplisay-sbc` and `agents/pipecat`. Images are
built by the Cloud Build configs in
[`deploy/gcp/cloudrun/`](../../deploy/gcp/cloudrun).

## License

MIT 