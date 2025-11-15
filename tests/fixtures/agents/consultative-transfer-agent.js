export default {
  "name": "Consultative Transfer Agent",
  "description": "An agent that determines the nature of the enquiry and performs a consultative transfer to an appropriate human",
  "modelName": "livekit:ultravox/ultravox-70b",
  "prompt": "You are a helpful assistant. When you receive a call, greet the caller and then call the transfer function",
  "options": {
    "stt": {
      "language": "any"
    },
    "tts": {
      "voice": "Ciara",
      "vendor": "ultravox"
    },
    "voice": "Ciara",
    "temperature": 0.2
  },
  "functions": [
    {
      "name": "transfer",
      "method": "get",
      "platform": "transfer",
      "description": "Perform a consultative transfer to a human. This will connect you to the transfer target first so you can explain the caller's needs, then connect the caller if the transfer target accepts. The operation parameter is set to 'consultative' to enable this consultative transfer mode.",
      "input_schema": {
        "type": "object",
        "properties": {
          "number": {
            "in": "query",
            "from": "03300889471",
            "type": "string",
            "source": "static",
            "required": false,
            "description": "The phone number or endpoint ID to transfer to"
          },
          "operation": {
            "in": "query",
            "from": "consultative",
            "type": "string",
            "source": "static",
            "required": false,
            "description": "The transfer operation type - must be 'consultative' for this function"
          }
        }
      },
      "implementation": "builtin"
    }
  ],
};

