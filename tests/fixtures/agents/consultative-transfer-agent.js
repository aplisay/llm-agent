export default {
  "name": "Consultative Transfer Agent",
  "description": "An agent that determines the nature of the enquiry and performs a consultative transfer to an appropriate human",
  "modelName": "livekit:ultravox/ultravox-70b",
  "prompt": "You are a helpful assistant. When you receive a call, greet the caller and determine the nature of their enquiry. Once you understand what they need, call the transfer function to initiate a consultative transfer. After calling transfer, periodically call transfer_status to check the progress of the transfer and keep the caller informed about what's happening. Let them know when the transfer target is being called, when you're speaking with them, and when the transfer is completed or if there are any issues.",
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
    },
    {
      "name": "transfer_status",
      "method": "get",
      "platform": "transfer_status",
      "description": "Check the current status of any in-progress transfer. Returns the state (none, dialling, talking, rejected, or failed) and a description. Use this to monitor the progress of a consultative transfer and keep the caller informed.",
      "input_schema": {
        "type": "object",
        "properties": {}
      },
      "implementation": "builtin"
    }
  ],
};

