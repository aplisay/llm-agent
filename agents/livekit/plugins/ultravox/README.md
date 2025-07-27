<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
# Ultravox Plugin for LiveKit Agents

This plugin provides integration with the Ultravox API for real-time voice conversations with AI agents.

## Features

- Real-time voice conversations with Ultravox AI models
- Support for function tool calling
- Audio streaming with WebSocket connections
- Event-driven architecture compatible with LiveKit Agents
- Support for both text and audio modalities

## Installation

```bash
npm install @livekit/agents-plugin-ultravox
```

## Usage

### Basic Usage

```typescript
import { RealtimeModel } from '@livekit/agents-plugin-ultravox';
import { llm } from '@livekit/agents';

// Create the model
const model = new RealtimeModel({
  apiKey: process.env.ULTRAVOX_API_KEY,
  instructions: 'You are a helpful assistant.',
  voice: 'alloy',
});

// Create a session
const session = model.session({
  chatCtx: new llm.ChatContext(),
});

// Listen for events
session.on('session_created', (event) => {
  console.log('Session created:', event.session.id);
});

session.on('response_done', (response) => {
  console.log('Response completed:', response.id);
});
```

### Function Tool Calling

The Ultravox plugin supports function tool calling, allowing the AI to execute custom functions during conversations.

```typescript
import { RealtimeModel } from '@livekit/agents-plugin-ultravox';
import { llm } from '@livekit/agents';
import { z } from 'zod';

// Define a function that can be called by the AI
const getWeatherFunction: llm.CallableFunction = {
  description: 'Get the current weather for a location',
  parameters: z.object({
    location: z.string().describe('The city and state'),
    unit: z.enum(['celsius', 'fahrenheit']).default('fahrenheit'),
  }),
  execute: async (args) => {
    // Your function implementation here
    return {
      location: args.location,
      temperature: 72,
      unit: args.unit,
      condition: 'sunny',
    };
  },
};

// Create function context
const functionContext: llm.FunctionContext = {
  getWeather: getWeatherFunction,
};

// Create the model with function context
const model = new RealtimeModel({
  apiKey: process.env.ULTRAVOX_API_KEY,
  instructions: 'You can get weather information using the getWeather function.',
  voice: 'alloy',
});

// Create a session with function context
const session = model.session({
  fncCtx: functionContext,
  chatCtx: new llm.ChatContext(),
});

// Listen for function call events
session.on('response_function_call_arguments_done', (event) => {
  console.log('Function called with arguments:', event.arguments);
});

session.on('conversation_item_created', (event) => {
  if (event.item.type === 'function_call_output') {
    console.log('Function result:', event.item.output);
  }
});
```

## Configuration Options

### ModelOptions

- `apiKey` (required): Your Ultravox API key
- `instructions`: System prompt for the AI
- `voice`: Voice to use for speech synthesis
- `temperature`: Controls randomness in responses (0.0-1.0)
- `model`: Ultravox model to use (default: 'fixie-ai/ultravox-70B')
- `baseURL`: Ultravox API base URL
- `maxDuration`: Maximum call duration
- `transcriptOptional`: Whether transcripts are optional
- `firstSpeaker`: Who speaks first in the conversation

### Audio Configuration

- `inputAudioFormat`: Input audio format (default: 'pcm16')
- `outputAudioFormat`: Output audio format (default: 'pcm16')
- `sampleRate`: Audio sample rate (default: 48000)
- `numChannels`: Number of audio channels (default: 1)

## Events

The plugin emits various events that you can listen to:

- `session_created`: When a new session is created
- `response_created`: When a new response starts
- `response_done`: When a response is completed
- `response_function_call_arguments_done`: When function arguments are received
- `conversation_item_created`: When a new conversation item is created
- `input_speech_started`: When user speech is detected
- `input_speech_transcription_completed`: When user speech is transcribed
- `response_audio_done`: When audio response is completed
- `response_text_done`: When text response is completed

## Function Tool Calling

### Supported Function Types

The plugin supports any function that follows the `llm.CallableFunction` interface:

```typescript
interface CallableFunction {
  description: string;
  parameters: z.ZodType | OpenAIFunctionParameters;
  execute: (args: any) => Promise<any>;
}
```

### Function Execution Flow

1. AI decides to call a function based on user input
2. Function call message is received from Ultravox
3. Function is executed using the provided function context
4. Function result is sent back to Ultravox
5. AI continues the conversation with the function result

### Error Handling

If a function execution fails, the error is sent back to Ultravox and the AI can handle it appropriately.

## Examples

See the `examples/` directory for complete working examples:

- `function_calling_example.ts`: Demonstrates function tool calling
- `basic_usage_example.ts`: Shows basic usage without functions

## Environment Variables

- `ULTRAVOX_API_KEY`: Your Ultravox API key (required)

## Limitations

- Function tool calling requires a valid Ultravox API key
- Functions are executed locally, not on Ultravox servers
- Audio streaming is one-way (input only)
- Some advanced features may require specific Ultravox plan

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

Apache-2.0
