# Ultravox Realtime Model Conversion

This document describes the conversion of the realtime_model from using the OpenAI Realtime API to the Ultravox API.

## Overview

The `realtime_model.ts` file has been completely rewritten to use the Ultravox API instead of the OpenAI Realtime API. The new implementation:

1. Uses the Ultravox API to create calls
2. Connects to Ultravox WebSocket for real-time audio communication
3. Handles audio frames and event messages between the Ultravox model and LiveKit room
4. Maintains compatibility with the existing LiveKit Agents framework

## Key Changes

### New Files Created

1. **`ultravox_api_proto.ts`** - Defines Ultravox API types and interfaces
2. **`ultravox_client.ts`** - HTTP client for Ultravox API calls
3. **`realtime_model.ts`** - Completely rewritten to use Ultravox API

### API Changes

#### Constructor Parameters

The `RealtimeModel` constructor now accepts Ultravox-specific parameters:

```typescript
const model = new RealtimeModel({
  apiKey: process.env.ULTRAVOX_API_KEY || '',
  model: 'fixie-ai/ultravox-70B',
  instructions: 'You are a helpful AI assistant.',
  voice: 'alloy',
  temperature: 0.8,
  maxDuration: '305s',
  timeExceededMessage: 'It has been great chatting with you, but we have exceeded our time now.',
  transcriptOptional: false,
  firstSpeaker: 'FIRST_SPEAKER_AGENT',
});
```

#### WebSocket Communication

Instead of connecting to OpenAI's Realtime API, the model now:

1. Creates a call via Ultravox API (`POST /api/calls`)
2. Connects to the returned WebSocket URL
3. Sends and receives audio frames and event messages

#### Audio Handling

- Audio frames are sent directly to the Ultravox WebSocket
- Incoming audio from Ultravox is converted to AudioFrame objects
- Transcripts are handled through Ultravox's transcript events

## Usage Example

```typescript
import { RealtimeModel } from '@livekit/agents-plugin-ultravox';
import { AudioFrame } from '@livekit/rtc-node';

// Create model
const model = new RealtimeModel({
  apiKey: process.env.ULTRAVOX_API_KEY || '',
  model: 'fixie-ai/ultravox-70B',
  instructions: 'You are a helpful AI assistant.',
});

// Create session
const session = model.session({
  chatCtx: undefined,
  fncCtx: undefined,
});

// Listen for events
session.on('input_speech_transcription_completed', (event) => {
  console.log('User said:', event.transcript);
});

session.on('response_audio_delta', (event) => {
  console.log('Received audio response');
});

// Send audio frames
const frame = new AudioFrame(/* ... */);
session.inputAudioBuffer.append(frame);

// Clean up
await session.close();
await model.close();
```

## Environment Variables

Set the following environment variable:

```bash
ULTRAVOX_API_KEY=your_ultravox_api_key_here
```

## Differences from OpenAI Realtime API

1. **Call Creation**: Uses Ultravox's call creation API instead of OpenAI's session-based approach
2. **WebSocket Protocol**: Different message format and event types
3. **Audio Format**: Ultravox uses 48kHz, 1 channel PCM16 audio
4. **Function Calling**: Limited support for function calling (only with 70B model)
5. **Session Management**: Simpler session management through Ultravox's call lifecycle

## Limitations

1. Some features from the OpenAI Realtime API are not supported in Ultravox:
   - Complex session updates
   - Advanced turn detection
   - Some conversation management features
2. Function calling is only available with the 70B model
3. Audio format is fixed to 48kHz, 1 channel PCM16

## Migration Notes

When migrating from the OpenAI Realtime API:

1. Update environment variables from `OPENAI_API_KEY` to `ULTRAVOX_API_KEY`
2. Change model names from OpenAI models to Ultravox models (e.g., `gpt-4o-realtime-preview-2024-10-01` → `fixie-ai/ultravox-70B`)
3. Remove Azure-specific parameters (`isAzure`, `apiVersion`, `entraToken`)
4. Add Ultravox-specific parameters (`maxDuration`, `timeExceededMessage`, `transcriptOptional`, `firstSpeaker`)
5. Update audio handling code to use Ultravox's audio format (48kHz, 1 channel)

## Testing

To test the implementation:

1. Set your Ultravox API key
2. Run the example: `node examples/ultravox_realtime_example.ts`
3. Check the logs for successful connection and message handling

## Future Improvements

1. Add support for function calling with proper tool conversion
2. Implement better error handling and retry logic
3. Add support for more Ultravox-specific features
4. Improve audio frame handling and buffering
5. Add comprehensive unit tests 