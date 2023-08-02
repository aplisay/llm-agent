const doc = {
  openapi: "3.0.0",
  servers: [{
    url: 'https://llm.aplisay.com/api'
  }
  ],
  info: {
    title: 'LLM Agent API',
    version: '1.0.0'
  },
  components: {
    schemas: {
      Model: {
        type: 'object',
        properties: {
          description: {
            description: "Agent Description",
            type: "string",
            example: "GPT3.5-turbo chat"
          },
          defaultPrompt: {
            description: "A working initial default prompt for this agent",
            type: "string",
            example: "You are a helpful agent..."
          }
        },
        required: ['name', 'defaultPrompt']
      },
      Agent: {
        type: 'object',
        properties: {
          modelName: {
            $ref: '#/components/schemas/ModelName'
          },
          prompt: {
              $ref: '#/components/schemas/Prompt'
          },
          options: {
              $ref: '#/components/schemas/AgentOptions'
          }
        }
      },
      ModelName: {
        type: 'string',
        description: 'The short model name',
        example: 'gpt-35'
      },
      Prompt: {
        type: 'string',
        description: 'The prompt to be used in the LLM engine',
        example: `You work for Robs Flags, a company that manufactures flags.
                  You can only chat with callers about submitting or organising the return of an order that the user has previously made...`
      },
      AgentOptions: {
        type: 'object',
        properties: {
          temperature: {
            description: "Agent LLM temperature",
            type: "number",
            example: 0.2
          },
          tts: {
            type: 'object',
            properties: {
              language: {
                description: `Language and country dialect specified as an ISO639-1 language code followed by a dash and and ISO3166 country code.
                                Must be a supported voicing language as returned from a get on the \`voices\` api`,
                type: "string",
                example: "en-GB"
              },
              voice: {
                description: `TTS voice specifier.
                                Must be a supported voice language as returned from a get on the \`voices\` api`,
                type: "string",
                example: "en-GB-Wavenet-A"
              },
            }
          },
          stt: {
            type: 'object',
            properties: {
              language: {
                description: `Language and country dialect specified as an ISO639-1 language code followed by a dash and and ISO3166 country code.
                                For now, list of supported recognition voices is identical to the voicing languages returned from the \`voices\` api.
                                This should change in future`,
                type: "string",
                example: "en-GB"
              }
            }
          }
        }
      },

      Error: {
        type: "object",
        properties: {
          code: {
            type: "string"
          },
          message: {
            type: "string"
          }
        },
        additionalProperties: true
      }
    }
  },
  paths: {}
};

module.exports = doc;