# llm-agent documentation

Index of the docs in this directory. Start with the first table if you're new; the rest are feature and integration references. Platform-level (hosted Aplisay) guides live at [aplisay.com/docs](https://aplisay.com/docs), and the REST API reference at [llm.aplisay.com/api](https://llm.aplisay.com/api).

## Start here

| Doc | What it covers |
|---|---|
| [running.md](running.md) | Install, environment, database, workers, tests, deployment |
| [architecture.md](architecture.md) | Control plane vs realtime plane, components, life of a call, scaling |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting policy |

## Building agents

| Doc | What it covers |
|---|---|
| [agent-sets-and-subagents.md](agent-sets-and-subagents.md) | Teams of agents: sets, label references, in-call subagents, handover |
| [multi-agent-api.md](multi-agent-api.md) | The multi-agent REST surface and agent-to-agent transfer |
| [mcp-servers.md](mcp-servers.md) | Attaching remote MCP tool servers to agents |
| [tool-call-chaining-metadata-priming.md](tool-call-chaining-metadata-priming.md) | Static/metadata parameter sourcing and chained tool calls |
| [prompt-metadata.md](prompt-metadata.md) | Stating call facts (date/time, caller number, seeded data) in the agent's prompt |
| [uninterruptible-greetings.md](uninterruptible-greetings.md) | Barge-in control for opening prompts |
| [auxiliary-stt.md](auxiliary-stt.md) | Side STT engines: a second opinion on the caller (`options.stt.aux` → `user-aux`, `stt-aux`) and an audit of what the agent actually said (`options.tts.output` → `agent-speech`, `stt-output`) |
| [ultravox-vendor-specific-options.md](ultravox-vendor-specific-options.md) | Ultravox model variants and tuning options |
| [agent-concurrency-limits.md](agent-concurrency-limits.md) | Per-agent/user/organisation concurrency caps |
| [agent-failover.md](agent-failover.md) | Automatic fallback agents and numbers |
| [voices-deprecation.md](voices-deprecation.md) | Deprecation notes for the legacy voices surface |

## Calls and telephony

| Doc | What it covers |
|---|---|
| [call-transfers.md](call-transfers.md) | Blind, consultative and bridged transfers; REFER/deflect; anti-fraud rules |
| [send-dtmf.md](send-dtmf.md) | The `send_dtmf` builtin: play out-of-band (RFC 4733) DTMF digits over a SIP call |
| [sip-headers.md](sip-headers.md) | Surfacing inbound SIP INVITE `X-` headers to the agent as `aplisay.sipHeaders` |
| [redirecting-calls.md](redirecting-calls.md) | Redirection as distinct from transfer |
| [human-handback-howto.md](human-handback-howto.md) | Handing a call back to a human with context |
| [transfer-back-plan.md](transfer-back-plan.md) | Delivery plan for transfer-back: listener override, transfer metadata, summariser pattern, bridged recording |
| [call-recording.md](call-recording.md) | Recording lifecycle, encryption, storage and retrieval |
| [call-hooks.md](call-hooks.md) | Webhooks on call milestones |
| [originate-api.md](originate-api.md) | Placing outbound calls from an agent/listener |
| [phone-endpoints-api.md](phone-endpoints-api.md) | DDIs, trunks and registrations as first-class endpoints |
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
[implementation/](implementation/) (auth, RBAC, users API and rate-card plans) · [release-notes/](release-notes/) · [plan-recording-rest-and-options.md](plan-recording-rest-and-options.md) · [CONTEXT.md](CONTEXT.md) (contributor/agent onboarding).
