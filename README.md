# llm-agent

LLM based Agent.

Interacts to Jambonz, OpenAI and Google Vertex to create, modify and manage AI agents which listen on free phone numbers in Jambonz, route the calls via an STT to the LLM of choice with an initial system prompt, and then take the completions and play them to the caller via an TTS.

## Installation

Clone this repo, and add the following environment variables:
```
OPENAI_API_KEY=<YOUR OPENAI KEY>
OPENAI_MODEL=gpt-3.5-turbo
GOOGLE_PROJECT_ID=<YOUR GOOGLE PROJECT ID>
GOOGLE_PROJECT_LOCATION="us-central1"
GOOGLE_APPLICATION_CREDENTIALS=<PATH TO CREDENTIAL JSON FILE>
JAMBONZ_SERVER=<JAMBONZ API SERVER HOSTNAME>, usually api.server.name
JAMBONZ_API_KEY=<JAMBONZ API KEY>
SERVER_NAME=<THIS SERVER DNS NAME>
```
```yarn install```
```yarn develop```

## Running
Implements an Expresss REST API. See [Swagger docs](https://llm-agent.aplisay.com/swagger/) to use this directly, or just use the [React frontend](https://github.com/aplisay/llm-frontend) as a playground.
## Implementation

See [Developer Documentation](API.md) for class structure
