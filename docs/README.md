# llm-agent documentation

Index of the docs in this directory. Start with the first table if you're new; the rest are feature and integration references. Platform-level (hosted Aplisay) guides live at [aplisay.com/docs](https://aplisay.com/docs), and the REST API reference at [llm.aplisay.com/api](https://llm.aplisay.com/api).

## Start here

| Doc | What it covers |
|---|---|
| [self-hosting/README.md](self-hosting/README.md) | Self-hosting index: what is in the repo and what is not, and how to get access |
| [self-hosting/quickstart-local.md](self-hosting/quickstart-local.md) | The whole stack on one machine with Docker Compose |
| [self-hosting/choose-a-runtime.md](self-hosting/choose-a-runtime.md) | The five runtimes, what each needs, and which to enable first |
| [self-hosting/telephony-routes.md](self-hosting/telephony-routes.md) | The open routes to the phone network: LiveKit SIP, `sipbridge`, Jambonz |
| [self-hosting/production-checklist.md](self-hosting/production-checklist.md) | What to check before an instance is reachable from the internet |
| [self-hosting/byo-trunk-sipbridge.md](self-hosting/byo-trunk-sipbridge.md) | Your own SIP trunk through the sipbridge gateway, step by step |
| [self-hosting/user-accounts.md](self-hosting/user-accounts.md) | Sign-in with an email and password beside API keys |
| [self-hosting/upgrading.md](self-hosting/upgrading.md) | Moving to a newer version, including the database schema step |
| [self-hosting/troubleshooting.md](self-hosting/troubleshooting.md) | Common faults by symptom |
| [running.md](running.md) | Install, environment, database, workers, tests, deployment |
| [self-hosting/configuration.md](self-hosting/configuration.md) | Every environment variable, by component (generated from `config/env.schema.json`) |
| [architecture.md](architecture.md) | Control plane vs realtime plane, components, life of a call, scaling |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting policy |

## Building agents

| Doc | What it covers |
|---|---|
| [agent-sets-and-subagents.md](agent-sets-and-subagents.md) | Teams of agents: sets, label references, in-call subagents, handover |
| [gpt-live-agent-sets.md](gpt-live-agent-sets.md) | Build GPT-Live teams with familiar sets: native delegation, existing text specialists and the wider model catalogue, with worked API examples |
| [multi-agent-api.md](multi-agent-api.md) | The multi-agent REST surface and agent-to-agent transfer |
| [gpt-live.md](gpt-live.md) | OpenAI GPT-Live: a voice model with a backend text agent (`delegate`), and how it relates to text subagents |
| [grok.md](grok.md) | xAI Grok: the Grok voice model on Pipecat, the Grok text and pipeline models, voices, options, `vendorSpecific.xai` and billing |
| [elevenlabs-agents.md](elevenlabs-agents.md) | ElevenLabs Agents on both voice workers: one row per LLM, how the hosted agent is reused per configuration, greetings, voices, `vendorSpecific.elevenlabs` and billing |
| [mcp-servers.md](mcp-servers.md) | Attaching remote MCP tool servers to agents |
| [tool-call-chaining-metadata-priming.md](tool-call-chaining-metadata-priming.md) | Static/metadata parameter sourcing and chained tool calls |
| [prompt-metadata.md](prompt-metadata.md) | Stating call facts (date/time, caller number, seeded data) in the agent's prompt |
| [uninterruptible-greetings.md](uninterruptible-greetings.md) | Barge-in control for opening prompts |
| [auxiliary-stt.md](auxiliary-stt.md) | Side STT engines: a second opinion on the caller (`options.stt.aux` → `user-aux`, `stt-aux`) and an audit of what the agent actually said (`options.tts.output` → `agent-speech`, `stt-output`) |
| [custom-voices.md](custom-voices.md) | Custom voices an organisation creates: OpenAI prompt voices on GPT-Live. Create, wait for, use and delete a voice; quota and permissions |
| [tts-speed.md](tts-speed.md) | Speaking rate (`options.tts.speed`): the multiplier, and how each vendor and model applies it |
| [ultravox-vendor-specific-options.md](ultravox-vendor-specific-options.md) | Ultravox model variants and tuning options |
| [agent-concurrency-limits.md](agent-concurrency-limits.md) | Per-agent/user/organisation concurrency caps |
| [chat-session-ownership.md](chat-session-ownership.md) | How an interactive chat session is held by one server process and moves to another on reconnect or shutdown |
| [agent-failover.md](agent-failover.md) | Automatic fallback agents and numbers |
| [voices-deprecation.md](voices-deprecation.md) | Deprecation notes for the legacy voices surface |

## Calls and telephony

| Doc | What it covers |
|---|---|
| [call-transfers.md](call-transfers.md) | Blind, consultative and bridged transfers; REFER/deflect; anti-fraud rules |
| [send-dtmf.md](send-dtmf.md) | The `send_dtmf` builtin: play out-of-band (RFC 4733) DTMF digits over a SIP call |
| [sip-headers.md](sip-headers.md) | Surfacing inbound SIP INVITE `X-` headers to the agent as `aplisay.sipHeaders` |
| [caller-id-name.md](caller-id-name.md) | The caller's SIP `From` display-name as `aplisay.callerIdName` |
| [redirecting-calls.md](redirecting-calls.md) | Redirection as distinct from transfer |
| [human-handback-howto.md](human-handback-howto.md) | Handing a call back to a human with context |
| [transfer-back-plan.md](transfer-back-plan.md) | Delivery plan for transfer-back: listener override, transfer metadata, summariser pattern, bridged recording |
| [call-recording.md](call-recording.md) | Recording lifecycle, encryption, storage and retrieval |
| [call-hooks.md](call-hooks.md) | Webhooks on call milestones |
| [originate-api.md](originate-api.md) | Placing outbound calls from an agent/listener |
| [phone-endpoints-api.md](phone-endpoints-api.md) | DDIs, trunks and registrations as first-class endpoints |
| [phone-system.md](phone-system.md) | Under development: the directory, phones and worked-out lines, the `phoneSystem` capability, and the internal routes for call control |
| [phone-numbers-api.md](phone-numbers-api.md) | Querying and managing phone numbers |
| [number-lifecycle-adding-a-number.md](number-lifecycle-adding-a-number.md) | Carrier-side provisioning and routing a new number in |
| [registration-workflow.md](registration-workflow.md) | SIP registration handling end to end |
| [registration-simulation.md](registration-simulation.md) | Exercising registration flows without a real carrier |
| [registration-trace-and-probe-api.md](registration-trace-and-probe-api.md) | SIP traces and live registration probes, proxied to the owning b2bua node |
| [uac_registation_address_tracking.md](uac_registation_address_tracking.md) | UAC registration address tracking notes |

## Runtimes and gateways

| Doc | What it covers |
|---|---|
| [livekit-agent-architecture.md](livekit-agent-architecture.md) | The LiveKit runtime in depth: worker lifecycle, SIP abstraction, realtime models |
| [livekit-pipecat-transfer-parity.md](livekit-pipecat-transfer-parity.md) | Feature parity between the LiveKit and Pipecat runtimes |
| [livekit-pipeline-api-implications.md](livekit-pipeline-api-implications.md) | API implications of LiveKit pipeline models |
| [sipbridge-integration.md](sipbridge-integration.md) | The bundled Go SIP bridge for the Pipecat runtime |
| [voiceblender-integration.md](voiceblender-integration.md) | Voiceblender B2BUA integration for the Pipecat runtime |

## Testing and CI

| Doc | What it covers |
|---|---|
| [ci-testing.md](ci-testing.md) | The CI pipeline and containerised test runner |
| [test-strategies.md](test-strategies.md) | What we test where, and why |
| [test-coverage.md](test-coverage.md) | Coverage expectations and reports |

## Working documents

Design plans and internal records — useful history, not user documentation:
[implementation/](implementation/) (auth, RBAC, users API, rate-card plans and custom voices) · [release-notes/](release-notes/) · [plan-recording-rest-and-options.md](plan-recording-rest-and-options.md) · [CONTEXT.md](CONTEXT.md) (contributor/agent onboarding; see also [../AGENTS.md](../AGENTS.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md)).
