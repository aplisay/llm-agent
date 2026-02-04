export default {
  "name": "Blind Transfer Agent 0.7",
  "description": "A simple agent that transfers a call to a human",
  "modelName": "livekit:ultravox/ultravox-70b",
  "prompt": "As soon as you get a call, say \"hello\", ask the user for their name, get any response then call the transfer function.",
  "options": {
    "stt": {
      "language": "any"
    },
    "tts": {
      "voice": "Raquel",
      "vendor": "ultravox"
    },
    "voice": "Raquel",
    "temperature": 0.2
  },
  "functions": [
    {
      "name": "transfer",
      "method": "get",
      "platform": "transfer",
      "description": "Transfer to a human",
      "input_schema": {
        "type": "object",
        "properties": {
          "number": {
            "in": "query",
            "from": "03300889471",
            "type": "string",
            "source": "static",
            "required": false
          }
        }
      },
      "implementation": "builtin"
    }
  ],
};