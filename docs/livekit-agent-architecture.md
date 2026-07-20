# LiveKit Agent Architecture

## 1. Overview and purpose

This document describes the LiveKit-based voice agent integration in `llm-agent` so that an engineer can replicate equivalent functionality on another stack — Pipecat, Vocode, a self-hosted WebRTC + provider mux, or anything else. It is written for re-implementers, not for operators or for engineers extending the LiveKit handler in place.

### Stance: contract over mechanism

The doc deliberately documents **functionality and contracts** rather than the LiveKit-specific mechanisms used to implement them. A re-implementer must preserve the contracts described here; the mechanisms are theirs to choose. Where a specific implementation detail is illustrative (a header name, a registry encoding, a port number), it is flagged as such — the LiveKit handler's choices are reference points, not specs to copy.

### Architecture in one paragraph

The integration spans two cooperating tiers: a **server-side handler** subclassing a shared base class and running inside the main `llm-agent` API server, and a **worker** process running the agent runtime. The server-side handler owns model and voice registries, in-band credentialed join, outbound origination, and concurrency reservation; the worker owns media handling, model and provider integration, tool dispatch, transfer state, recording, and logging. The two communicate via per-handler dispatch (chosen by the handler — LiveKit uses room metadata at dispatch time) and via REST callbacks the worker makes back to the `llm-agent` agent-db API.

### Scope

In scope:

- The contract surface a re-implementer must honor — handler class shape, REST callbacks, SIP wire headers, the built-in tool surface, transfer semantics, lifecycle and disconnect taxonomy, fallback and recording behaviour.
- Configuration knobs (agent options) that affect runtime behaviour.
- Known divergences between the contract documented here and the current LiveKit code (section 10).

Out of scope:

- LiveKit-specific implementation internals beyond what affects the contract.
- Operational and deployment concerns (capacity planning, monitoring, billing) beyond what the contract requires.
- Any UI or product concerns above the agent layer.

## 2. Process topology and dispatch

The integration spans two cooperating tiers: a **server-side handler** running inside the `llm-agent` API server, and a **worker** running the agent runtime. Each tier has distinct responsibilities; the boundary between them is the REST callback contract (section 8) plus whatever per-handler dispatch the handler chooses internally.

### 2.1 Server-side responsibilities

The server-side handler owns:

- The model and voice registries (what the handler can run; what voices each model supports).
- Concurrency-reservation orchestration.
- The outbound originate entrypoint (`Handler.outbound`).
- The non-SIP credentialed join entrypoint (`Handler.join`).
- The REST contract surface that the worker calls back into.

The server-side API interfaces are **fixed**. Re-implementers must not change the shape or interfaces of the agent-db REST contract; extending it is a last resort, undertaken only when no existing endpoint fits a genuinely new requirement.

### 2.2 Worker-tier responsibilities

The worker tier owns:

- Media handling and audio transport.
- Model and provider integration (realtime providers, pipeline STT / LLM / TTS).
- Tool dispatch (section 5).
- Transfer state (section 6.10).
- Recording finalization (section 9.2).
- Transaction and invocation logging (sections 8.4, 9.3).

Worker process topology is an implementation choice — single process, multi-process, threaded, lambda-style, etc. The deployment constraint is that the worker must be **containerised and capable of running anywhere**, including in auto-scaling cloud environments.

### 2.3 Inbound dispatch

Inbound dispatch is driven by the SIP signaling layer (SBC or B2BUA) per section 6. The lookup chain — number → PhoneEndpoint or PhoneRegistration → Instance → Agent — is detailed in 6.2 / 6.3. Whether the lookup runs server-side, worker-side, or split between them is implementation choice.

### 2.4 Outbound dispatch — `Handler.outbound`

The static method on the handler is the contract entry point for platform-originated outbound calls (originate API, transfer fallback):

```
Handler.outbound({ instance, callerId, calledId, metadata, aplisayId })
```

Responsibilities:

- Reserve agent concurrency (section 7.1) before the worker is dispatched. On busy, throw `429` / `AGENT_CONCURRENCY_LIMIT_EXCEEDED`.
- Dispatch the worker with the call context.
- Return a dispatch result on success.

How the handler actually ferries the call context to its worker — LiveKit's `AgentDispatchClient` with a JSON metadata blob, HTTP, gRPC, a queue, an in-process function call — is the handler's choice. The dispatch payload shape is not part of the contract; only the entry-point method signature and behaviour are.

### 2.5 In-band join — `Handler.join`

Every handler must support a non-SIP credentialed join path so browser or in-band clients can become first-class participants in the call session. The flow:

1. The client calls the listener endpoint on the API server.
2. The server-side handler's `join()` is invoked. It mints whatever runtime-specific credentials are needed for the client to reach the worker.
3. The client uses those credentials to connect to the worker's runtime directly.

**Credentials are namespaced by handler name.** Each handler returns its credentials wrapped in a top-level object key matching its handler name. The LiveKit handler returns:

```
{ livekit: { serverUrl, roomName, participantToken, participantName } }
```

Any other handler must return `{ <handlername>: <its-own-credentials> }`. This namespacing keeps the listener endpoint response polymorphic across handlers without key collisions; clients select the right credentials by inspecting which key is present in the response.

The capability of credentialed join is contract; the credential format inside the namespace is handler-specific.

### 2.6 Contract summary

A re-implementer must honor:

- **Two cooperating tiers** — server-side handler in the API server, worker running the agent runtime.
- **Immutable server-side API** — no changes to existing `agent-db` REST shapes; extensions are a last resort.
- **Containerised worker** — process topology is implementation choice, but the worker must run anywhere.
- **Inbound dispatch via SIP** with lookup chain per section 6.
- **`Handler.outbound`** as the contract entry point for outbound origination; concurrency reserved before dispatch; busy returns `429` / `AGENT_CONCURRENCY_LIMIT_EXCEEDED`.
- **`Handler.join`** as the contract entry point for non-SIP credentialed join; response credentials namespaced by handler name.

## 3. Server-side handler contract

A handler is a subclass of the shared base `Handler` class in [lib/handlers/handler.js](lib/handlers/handler.js). The base provides default implementations of most of the contract, including modelName parsing, lifecycle hooks, and event helpers; the subclass adds its own static identity and capability declarations and overrides instance methods only where handler-specific behavior is genuinely required.

### 3.1 Registration

Handlers are registered with the API server by adding their module to the import list in [lib/handlers/index.js](lib/handlers/index.js). The server iterates the registered handler classes to compute the publicly-visible model catalog, route incoming calls, and shut down gracefully. There is no auto-discovery; registration is explicit.

### 3.2 Mandatory static surface

Every new handler must declare:

- **`static name`** — the handler identifier. Appears as the `<handlername>:` prefix in `agent.modelName` and as the namespace key in `Handler.join` responses (section 2.5).
- **`static description`** — display label.
- **`static models`** — array of LLM model implementation classes the handler supports. The base derives the publicly-visible model list (`<handlername>:<modelname>`) by combining `name` with each model's `allModels`.
- **`static voices`** — must be overridden; should return all voices the handler's models can use. The default base behavior is general-purpose and not appropriate for new handlers.
- **`static needKey`** — environment variables the handler requires to function (e.g. `{ LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL }`).
- **`static hasDynamicMetadata = true`** — mandatory for new handlers (section 5.5).
- **`static async outbound(...)`** — outbound origination entry point (section 2.4).

### 3.3 Capability flags

Every handler should explicitly declare which capabilities it provides. The flags default to `false` on the base; subclasses set `true` for what they support:

- **`hasTelephony`** — handler supports SIP-originated calls (inbound from SBC/B2BUA, outbound via SIP).
- **`hasWebRTC`** — handler supports browser / in-band participants; `Handler.join` is meaningful.
- **`hasWebSocket`** — handler supports the WebSocket update-streaming interface (`handleUpdates`).
- **`hasTransfer`** — handler supports the `transfer` built-in (section 5.1).
- **`hasDynamicMetadata`** — section 5.5.

The flags drive the publicly-visible model catalog (telephony / WebRTC capability is exposed per model) and gate features at runtime.

### 3.4 Loadability — `canLoad` and `needKey`

`static canLoad` is part of the loadability contract. The base implementation returns true if all variables in `needKey` are set in the environment. The API server filters out handlers that cannot load when computing the publicly-visible model catalog, so missing env vars exclude a handler cleanly rather than failing at call time.

Subclasses may override `canLoad` for custom loadability logic, but the env-var check via `needKey` is the standard contract.

### 3.5 Constructor and instantiation

The base `Handler` constructor takes `{ agent, instance, logger }`, stores them on `this`, parses `agent.modelName` to identify the handler / LLM implementation / model, and instantiates the LLM model on `this.model`. New handlers typically inherit the constructor unchanged.

When a call begins for a given instance, the API server resolves the right handler subclass from the agent's `modelName` and constructs an instance with `{ agent, instance, logger }`. Re-implementers do not need to provide the factory, only the subclass.

### 3.6 Instance lifecycle methods

The fundamental operation across the lifecycle methods below is to create, manage, and destroy a per-call (or per-listener) **Instance** record that links a number or registration to an agent and carries per-instance options. Most of this work is in the base class. The LiveKit handler does not override `activate` at all — it relies entirely on the base implementation. New handlers should follow suit: only override when handler-specific instance setup is genuinely required, and push reusable logic into the base class rather than duplicating across handlers.

- **`activate({ number, id, options, websocket })`** — entry point for a new active instance. Creates the Instance record, allocates phone numbers / registrations as needed, generates per-instance auth keys, and returns a connection descriptor (e.g. socket path for progress streaming). Largely covered by the base class; subclasses extend only when needed.
- **`handleUpdates(ws)`** — sets up a WebSocket connection back to the originating client to stream call events (transaction logs, status updates) live. Required when `hasWebSocket = true`. Base implementation forwards events to the WebSocket; subclasses typically do not override.
- **`join()`** — non-SIP credentialed join (section 2.5). Required when `hasWebRTC = true`. Returns runtime-specific credentials wrapped in a `<handlername>` namespace key.
- **`deactivate()`** — base lifecycle hook called at call end; cleans up the DB instance and any registered state. Subclasses override to do their own teardown (LiveKit's `destroy()` performs additional call-end cleanup).

### 3.7 Contract summary

A re-implementer must honor:

- **Subclass the base `Handler`** and register the module in `lib/handlers/index.js`.
- **Mandatory static members** — `name`, `description`, `models`, `voices`, `needKey`, `hasDynamicMetadata = true`, `outbound`.
- **Capability flags** — declare `hasTelephony`, `hasWebRTC`, `hasWebSocket`, `hasTransfer` as appropriate.
- **`canLoad`** honors `needKey`.
- **Constructor** — inherit from base unchanged.
- **Instance lifecycle methods** — `activate`, `handleUpdates`, `join`, `deactivate`. Lean on base class; only override where genuinely required, and push reusable logic into the base.

## 4. Voice modes: pipeline and realtime

The voice stack composes one of two ways:

- **Realtime** — a single provider model handles speech-to-speech end to end. Audio in, audio out, in one stage.
- **Pipeline** — discrete stages composed into one session: STT (audio → text) → LLM (text → text + tool calls) → TTS (text → audio). Tool calls execute between LLM and TTS.

An implementer will be familiar with the tradeoffs; a comprehensive re-implementation typically supports both and surfaces the choice to operators rather than picking one. The contract below assumes both are available.

### 4.1 Mode selection

Mode selection follows three rules in order:

1. If `agent.options.voiceMode` is set, it wins. The only valid values are `"pipeline"` and `"realtime"`. Operators set this explicitly to override the registry-driven default — for testing, A/B comparison, or when the registry rule isn't the right answer for a particular agent.
2. Otherwise, the agent's `modelName` is looked up in the handler's pipeline-mode registry. If present, the mode is `pipeline`.
3. Otherwise, the mode is `realtime` (the implicit default).

Mode resolution runs handler-side.

If `voiceMode` is set to a value inconsistent with the model — `"pipeline"` on a model not in the pipeline registry, or `"realtime"` on a model that is in it — the API server rejects the agent creation or update; this combination cannot reach the worker.

`modelName` is an opaque, handler-scoped string. The server tier routes to a handler by the leading scope (e.g. `livekit:`) and does not interpret what follows. Inside a handler tree, that suffix can be anything the handler chooses. The LiveKit handler happens to encode it as `<vendor>/<model-id>` and uses a set for membership lookup, but neither the encoding nor the data structure is part of the contract — the rule "registry membership decides pipeline-vs-realtime" is.

### 4.2 The pipeline registry — single source of truth

A re-implementer's pipeline registry must live exactly once, in `agents/{technology}/`, owned by the handler tree. Other tiers (e.g. a server-side model picker UI) read from it; they do not maintain their own copy.

The current LiveKit implementation duplicates this list across the worker ([agents/livekit/lib/livekit-pipeline-model-ids.ts](agents/livekit/lib/livekit-pipeline-model-ids.ts)) and the server ([lib/models/livekit.js](lib/models/livekit.js) — `PIPELINE_MODEL_ROWS`), with comments in both warning them to be kept in sync. This is a wart, not a pattern to replicate.

For reference, the LiveKit pipeline registry today contains:

```
openai/gpt-4o-mini
openai/gpt-4o
openai/gpt-5-mini
google/gemini-2.5-flash
google/gemini-2.0-flash
```

The exact contents are scoped to the handler and will change over time; the list is illustrative, not prescriptive.

### 4.3 The realtime path

A realtime model handles audio in and audio out in one stage. Turn-taking, voice-activity detection and interruption are the provider's responsibility — the runtime does not configure them.

`agent.options.stt` and `agent.options.tts` still apply in realtime mode, even though the provider supplies its own internal STT and TTS. They tune the analogous internal stages — for example `stt.language` sets the input language, `tts.voice` selects the speaking voice. The keys carry the same shape and meaning as in pipeline mode (4.4); their effect is mediated by the realtime provider rather than selecting a separate stage.

The LiveKit handler currently wires three realtime providers — OpenAI Realtime, Ultravox, Google Gemini Live. The provider set is extensible and not part of the contract.

Realtime output is customisable: when `agent.options.tts.vendor` is set to a vendor different from the realtime provider's own (for example an Ultravox model paired with a Deepgram TTS), the realtime model runs in text-output mode and a separate TTS handles audio out. STT and LLM remain a single stage inside the provider; only the TTS stage is decomposed. The session is architecturally still realtime — this is a customisation of realtime output, not a separate mode.

This customisation is slated for imminent development in the LiveKit implementation and is not yet wired. A re-implementer's runtime should be structured to allow it.

### 4.4 The pipeline path

A pipeline session composes three stages: STT → LLM → TTS. Tool calls (section 5) are emitted by the LLM between turns and executed before TTS runs.

In pipeline mode, `agent.options.stt` and `agent.options.tts` select discrete stages explicitly: `tts.vendor` chooses the TTS provider, `tts.voice` the voice ID, `stt` the STT (with optional language). The LLM is identified by the agent's `modelName`. The same keys behave differently in realtime mode (4.3) — there they tune internal stages or trigger output customisation. (Full agent-options list in section 9.)

#### 4.4.1 Routing optionality

How a stage reaches its provider — through an aggregator API (LiveKit Inference, or an equivalent from another vendor) versus the provider's own SDK with operator-supplied keys — is an implementation choice, not a contract. The LiveKit worker exposes an environment-variable switch (`LIVEKIT_PIPELINE_USE_PROVIDER_KEYS`) that flips between the two; this exists for commercial optionality (token-buying through the aggregator versus direct billing) and for operational reasons such as regional routing, compliance, or dedicated-key isolation. A re-implementer should preserve a similar optionality through their own configuration mechanism if appropriate for their stack — but neither the existence of an aggregator nor the specific env-var name is prescriptive.

#### 4.4.2 Turn detection

Pipeline mode requires an explicit turn-detection mechanism, since the LLM stage is text-driven and has no native voice activity awareness. Two algorithms are used in practice:

- **VAD-based** — a voice-activity-detection model (e.g. Silero) emits speech/silence boundaries. Typically requires a prewarm step.
- **STT-based** — silence boundaries derived from the STT stream itself.

The contract is that pipeline mode must support at least one. VAD is the richer option and is preferred; supporting STT-based turn detection alone is acceptable as a minimum.

Realtime mode does not expose this knob — turn detection is the provider's responsibility.

### 4.5 Greeting

By default, the agent speaks first when the call connects, but the greeting is interruptible — if the user starts speaking, the agent yields.

Uninterruptible greetings are an explicit feature, controlled by `agent.options.greeting`:

- `greeting.text` — a fixed text string spoken through TTS with interruption disabled. Use when the opening line is invariant.
- `greeting.instructions` — a prompt fragment driving an LLM-generated opening with interruption disabled. Use when the opening should adapt to context.

The two keys are mutually exclusive; exactly one of `text` or `instructions` may be set. When neither is set, default-interruptible behavior applies.

The greeting contract is mode-independent. Implementations may differ in how the behavior lands per provider — for example Ultravox realtime drives uninterruptible greetings via its native `firstSpeakerSettings`, while other realtime providers and pipeline mode use TTS `say()` or LLM `generateReply` with explicit interruption suppression — but the contract is the behavior, not the mechanism.

### 4.6 Vendor-specific passthrough

Some provider knobs are not normalised across the runtime abstraction. The LiveKit implementation surfaces these via a free-form `vendorSpecific` object on `agent.options`, passed through to the underlying model unchanged.

This is load-bearing in practice — Ultravox transcription provider settings, for example, ride this channel today. A re-implementer must preserve an equivalent escape hatch even if their default abstraction normally hides per-provider knobs.

### 4.7 What does not differ between modes

The mode fork is only about audio and LLM stage composition. Everything else is uniform across both modes:

- Tool surface and how tool calls are executed (section 5).
- SIP and transfer behavior (section 6).
- Call lifecycle and disconnect taxonomy (section 7).
- REST callbacks back to `llm-agent` (section 8).
- Recording and invocation logs (section 9).

A re-implementer should design these contracts mode-blind.

### 4.8 Contract summary

A re-implementer must honor:

- Two voice modes — realtime (speech-to-speech) and pipeline (STT → LLM → TTS).
- Mode-selection rule — explicit `agent.options.voiceMode` (`"pipeline"` or `"realtime"` only) > pipeline-registry membership > realtime default.
- A single pipeline registry, owned by the handler tree, read by other tiers.
- A pipeline turn-detection mechanism (VAD-based preferred, STT-based acceptable as a minimum).
- Default agent-speaks-first-interruptibly greeting, with `agent.options.greeting.{text|instructions}` opting into an uninterruptible greeting (mutually exclusive); mode-independent.
- A vendor-specific passthrough escape hatch on agent options.

## 5. Built-in tool surface

The tool surface is what the LLM can see and call during a conversation. Two categories of tools are exposed: **built-in tools** that the platform provides for free, and **user-defined functions** declared on the agent. Both flow through the same dispatch library; built-ins are simply pre-registered with platform-level implementations.

### 5.1 Built-in tools

Every LiveKit agent has four built-in tools:

- **`metadata(keys)`** — read one or more keys from call metadata. Accepts a single key string or an array of strings. Returns `{ key: value }` for each requested key, or `'unknown'` for missing keys.
- **`hangup()`** — agent-initiated call termination. Triggers the `AGENT_INITIATED_HANGUP` disconnect path (section 7.3).
- **`transfer(number, callerId?, operation?, transferPrompt?, consultFeedback?, forceBridged?)`** — blind or consultative transfer to another destination. Full transfer semantics are in section 6.10.
- **`transfer_status()`** — query the in-progress transfer state machine. Returns `{ state, description }`, where `state` is one of the values from section 6.7.

### 5.2 Parameter sources and schema filtering

Every tool parameter declares a `source` controlling where its value comes from:

- **`generated`** — value supplied by the LLM at call time. Visible to the LLM in the tool schema.
- **`static`** — value hardcoded in the function definition's `from` field. Resolved server-side; never visible to the LLM.
- **`metadata`** — value pulled from a dot-path into call metadata via `entry.from` (e.g. `aplisay.callId`). Resolved server-side; never visible to the LLM.

The LLM-facing tool schema is filtered: only `source: "generated"` properties appear on the wire to the model. Static and metadata properties remain in the function definition but invisible to the LLM. The `required` array on the LLM-facing schema is derived from each property's `required` flag.

**`transfer.number` source restriction.** To prevent prompt-injection-driven destination changes, `transfer.number` may only be `source: "static"` or `source: "metadata"` — never `"generated"`. This is a hard security boundary that the dispatcher enforces.

### 5.3 Dispatch via the `functionHandler` library

Function execution is centralized in a shared library at `lib/function-handler.js`. All handlers reuse it rather than re-implementing dispatch logic. The library is responsible for:

- **Source resolution** — for each parameter, pick its value from the LLM args (`generated`), the function definition (`static`), or call metadata (`metadata`).
- **Sequential execution** — within a single tool-call batch, functions execute sequentially, not in parallel. This is required so that later tools can read results written to `metadata.toolsCalls` by earlier tools.
- **Result writeback** — after each function executes, parameters and result are written to `metadata.toolsCalls[toolName]` for chaining (section 5.4).
- **Error capture** — execution errors are captured in `function_results[].error` and `metadata.toolsCalls[toolName].error`. The LLM sees the error description in its tool result so it can adapt.

Every function declares an `implementation` controlling how it is actually dispatched:

- **`builtin`** — calls one of the platform's built-in implementations via the function's `platform` field (e.g. `platform: "transfer"`).
- **`rest`** — HTTP callout. The function definition supplies URL, method, auth headers (which themselves source from `static`/`metadata`), and parameter routing rules (path, query, body).
- **`stub`** — no-op execution. Emits the call and parameters to conversation logs but does not actually run anything. Useful for planning, tracing, or simulating.

The library's extension point for built-ins is a two-level merge:

- **Hardwired** built-ins are baked into the library and available to every handler. Currently this is just `metadata` (the metadata reader).
- **Handler-specific** built-ins are passed in at dispatch time by the caller — for the LiveKit agent, [agents/livekit/lib/agent-tools.ts](agents/livekit/lib/agent-tools.ts) passes `hangup`, `transfer`, and `transfer_status`.

This is the contract for extending the built-in surface: a new handler (e.g. a future Pipecat handler) adds its own platform tools by passing them in alongside the call to the function handler, without re-implementing source resolution, chaining, or redaction.

The library also receives runtime capability flags (`allowToolsCallsMetadataPaths`, `allowRedactedFunctionResults`) from the caller. These are derived from the handler's `hasDynamicMetadata` declaration (section 5.5).

### 5.4 Result chaining and redaction

After each tool executes, its parameter and result are written to `metadata.toolsCalls[toolName]`. Later tools in the same conversation can reference these values via `source: "metadata"` paths like `toolsCalls.someTool.result.fieldName`. This enables algorithmic — rather than LLM-mediated — chaining: the platform guarantees the second tool's input is exactly the first tool's output, with no possibility of the LLM inventing or modifying the value in between.

When a function declares `redact: true`, the LLM-visible result is replaced with a generic `"OK"` while the real result still gets written to `metadata.toolsCalls[toolName].result` for chaining. This gives confidentiality (the LLM never sees the value) on top of the integrity that source-restricted parameters provide.

Full details, including security model, examples, and the rationale for tool-call chaining, are in [docs/tool-call-chaining-metadata-priming.md](docs/tool-call-chaining-metadata-priming.md).

### 5.5 `hasDynamicMetadata` capability

Handlers declare a static `hasDynamicMetadata` capability flag. Handlers with `hasDynamicMetadata = true` enable two privileged features:

- Access to `metadata.toolsCalls.*` paths via `source: "metadata"` — required for the chaining described in 5.4.
- The `redact: true` privilege on function definitions — required for redaction described in 5.4.

Without the flag, attempts to use either feature throw at runtime.

The flag is mandatory for new handlers — implementing it correctly is part of the contract for any handler that wants tool-call chaining and redaction support. `hasDynamicMetadata = false` exists only as a transitional accommodation for legacy handlers that have not yet been updated; new implementations must declare it true.

### 5.6 Contract summary

A re-implementer must honor:

- **Built-in tool surface** — `metadata`, `hangup`, `transfer`, `transfer_status`. Parameter lists, return shapes, and behavior per 5.1 (and section 6 for transfer / transfer_status semantics).
- **Parameter `source` enum** — `generated`, `static`, `metadata`. LLM sees only `generated`; `static` and `metadata` resolved server-side. `transfer.number` may not be `generated`.
- **Tool dispatch via the shared `functionHandler` library** — sequential execution, source resolution, `metadata.toolsCalls` writeback, error capture. Hardwired and handler-specific built-ins merge at dispatch time. `implementation` enum: `builtin`, `rest`, `stub`.
- **Result chaining** via `source: "metadata"` paths into `toolsCalls.<name>.result`.
- **Result redaction** via `redact: true` on the function definition.
- **`hasDynamicMetadata` capability flag** — mandatory `true` for new handlers; gates chaining and redaction privileges.

## 6. SIP and transfer contract

The agent participates in SIP signaling with two upstream roles, each with its own header set, lookup chain and lifecycle. The contract below treats them separately because the routing decisions and trust model differ.

Wire headers are the contract; how the agent reads them locally (e.g. as participant attributes, as raw SIP message fields) is mechanism.

### 6.1 Upstream signaling roles

- **SBC (Session Border Controller)** — handles trunk-based calls, where one or more SIP trunks terminate at the platform. Inbound trunks identify the originating call by an `aplisayId`; outbound trunks route platform-originated INVITEs to the PSTN.
- **B2BUA (Back-to-Back User Agent)** — handles registration-originated calls, where SIP endpoints (softphones, hard phones, PBX trunks) register against the platform's registration service. Inbound calls from a registered endpoint flow through the B2BUA; outbound calls back to a registered endpoint go through it as well.

A re-implementer must implement both contracts to support the full agent feature set.

### 6.2 Inbound SIP — SBC path

On an inbound INVITE from the SBC, the contract is:

- `X-Aplisay-Trunk` — wire header carrying the trunk identity. The agent extracts this as the `aplisayId`.
- Request-URI — supplies the called number.
- From header — supplies the caller number.

Lookup chain: (called number, `aplisayId`) → PhoneEndpoint → Instance → Agent. The PhoneEndpoint record carries any per-trunk flags, notably `canRefer` (see 6.7).

Beyond routing, **all** `X-` headers on the inbound INVITE (including the routing ones above) are surfaced to the agent as `metadata.aplisay.sipHeaders` (a `{ "x-header-name": value }` map, keys lowercased) so agent logic and tools can read per-call context the SBC/carrier attached — see [`sip-headers.md`](sip-headers.md). LiveKit delivers them as `sip.h.x-*` participant attributes (the trunk is created with `includeHeaders = SIP_X_HEADERS`); on the Pipecat runtime the sipbridge and voiceblender gateways carry the same set.

### 6.3 Inbound SIP — B2BUA path

On an inbound INVITE from the B2BUA (registration-originated), the contract is:

- `X-Aplisay-PhoneRegistration` — Aplisay-domain wire header carrying the registration endpoint UUID.
- `X-Lk-RealIp` — infrastructure-layer wire header carrying the B2BUA gateway IP/hostname (used to construct the outbound dynamic trunk back to the same gateway).
- `X-Lk-Transport` — infrastructure-layer wire header carrying the transport (`tcp` / `udp` / `tls`) used to reach the registrar.

Lookup chain: registration endpoint UUID → PhoneRegistration → Instance → Agent. The PhoneRegistration record carries options that affect transfer behavior, notably `forceBridged` (see 6.7).

### 6.4 Outbound SIP — SBC path

For platform-originated outbound calls (transfer or originate API), the agent sends INVITE through the SBC's outbound trunk with the following wire headers:

- `X-Aplisay-Trunk` — the trunk identity (`aplisayId`) for the call's origination phone number. The agent **must** resolve this from a database lookup of the origination number (via `GET /api/agent-db/phone-endpoints?number=...`, see 8.2) before sending the INVITE. This header is the basis on which the SBC enforces number ownership and assigns billing — setting it incorrectly (or copying it blindly from the inbound INVITE without re-validating ownership of the origination number) breaks both. The lookup is required regardless of whether the outbound is an originate-API call (origination number from the request) or a transfer (origination number from the call context, possibly overridden by `transfer.callerId`).
- `X-Aplisay-Origin-Caller-Id` — the effective caller ID to display to the transfer target.
- `X-Aplisay-Call-Id` — the platform call UUID, for tracing and recording correlation.

### 6.5 Outbound SIP — B2BUA path

For outbound calls to a registered endpoint, the agent creates one outbound SIP trunk per (B2BUA gateway IP, transport) pair, authenticating with operator-configured shared credentials. The trunk is created on demand and reused across calls that share the same gateway and transport.

Trunk-naming convention, port numbers, and credential env-var names are deployment-bookkeeping, not contract — a re-implementer's deployment may use any conventions it chooses.

The outbound INVITE carries:

- `X-Aplisay-PhoneRegistration` — the registration endpoint UUID, correlating the outbound call back to the source registration.
- `X-Aplisay-Origin-Caller-Id` — the effective caller ID.
- `X-Aplisay-Call-Id` — the platform call UUID.

### 6.6 Number normalization and destination validation

All outbound destination numbers are normalized to E.164 form. The platform has a default-country setting that controls regional padding rules (e.g. mapping a leading `0` to the country code, prepending `+`).

Destination validation is applied before any outbound is dispatched:

- `agent.options.outboundCallFilter` — anchored regex applied to the destination. Calls whose destination doesn't match are rejected.
- `transfer.callerId` override — when a caller ID is overridden on a transfer call, the agent validates that the user owns that number before honoring the override.

### 6.7 Transfer — REFER vs blind-bridge decision

Two transfer mechanisms are available: SIP REFER (the upstream replays the call to the new destination) and blind-bridge (a new outbound participant joins the existing call session, the original participant disconnects when the new one answers).

REFER capability (`canRefer`) is determined in this order:

1. WebRTC participant — `canRefer = false` (WebRTC has no SIP REFER semantics).
2. Registration-originated SIP — `canRefer = true` by default.
3. Trunk-based SIP — `canRefer = trunk.flags.canRefer` (per-trunk flag from PhoneEndpoint).
4. Trunk info missing — `canRefer = false` (conservative default).

`forceBridged` overrides `canRefer`. It is set either on the PhoneRegistration's options (forcing all transfers from that endpoint to use blind-bridge) or as a per-call argument on the `transfer` function. When set, the transfer is always blind-bridge regardless of REFER capability.

The agent must resolve both `canRefer` and `forceBridged` before initiating any transfer.

### 6.8 Transfer — REFER mechanics

When `canRefer = true` and `forceBridged = false`, the agent issues SIP REFER on the wire:

- `Refer-Sub: false` and `Supported: norefersub` — the agent suppresses the NOTIFY subscription. The agent does not consume NOTIFY responses; the upstream (SBC or B2BUA) owns the leg from REFER onwards.
- Refer-To URI:
  - SBC path — `tel:<number>` (the SBC routes via its outbound trunk).
  - B2BUA path — `sip:<number>@<registrar>;transport=<tcp|udp|tls>` (the B2BUA routes via the registered endpoint).
- `X-Aplisay-Origin-Caller-Id` and `X-Aplisay-Call-Id` carried on the REFER for caller-ID and tracing continuity.

After REFER is sent, the agent's responsibility ends. The original participant is bridged to the new destination by the upstream.

### 6.9 Transfer — blind-bridge mechanics

When `canRefer = false` or `forceBridged = true`, the agent creates a new outbound SIP participant in the same call session as the original caller, using the outbound contracts in 6.4 / 6.5.

Media bridges through the agent. The new participant is invited with `waitUntilAnswered` semantics — the original participant is disconnected when the bridged participant answers (200 OK). When the bridged participant later hangs up, the call ends with a `BRIDGED_PARTICIPANT` reason. Full disconnect-reason taxonomy is in section 7.

### 6.10 Consultative transfer

Consultative (warm) transfer differs from blind transfer in that a TransferAgent first consults privately with the transfer target, then decides whether to bridge or cancel.

The contract has three pieces:

**Privacy.** The consultation is private; the original caller does not hear it. The mechanism for achieving privacy is an implementation choice — separate session, out-of-band SIP, audio mute, etc.

**Inputs to the TransferAgent.** At consultation time the TransferAgent receives a system prompt resolved by precedence:

1. Per-call `transfer.transferPrompt` argument.
2. `agent.options.transferPrompt`.
3. Built-in default prompt.

The chosen prompt may contain a `${parentTranscript}` placeholder, which is replaced with the parent conversation transcript before the TransferAgent runs.

**Outcomes.** The TransferAgent uses tool calls to indicate accept or reject:

- **Accept** — currently always followed by blind-bridge. REFER is not yet supported for consultative transfers; this may change. The original caller is disconnected on bridge answer, as per 6.9.
- **Reject** — the original caller resumes with the original agent. Rejection reasons are discovered through the TransferAgent's tool-call interactions with the target.

`consultFeedback` controls whether the rejection reason is exposed to the parent agent: when true, the reason is set on the parent agent's `transferState` so the parent agent can adapt; when false or omitted, the parent agent sees only a generic "Transfer failed".

### 6.11 Contract summary

A re-implementer must honor:

**Wire headers**

- Inbound SBC: `X-Aplisay-Trunk` plus standard SIP fields.
- Inbound B2BUA: `X-Aplisay-PhoneRegistration`, `X-Lk-RealIp`, `X-Lk-Transport`.
- Outbound SBC: `X-Aplisay-Trunk`, `X-Aplisay-Origin-Caller-Id`, `X-Aplisay-Call-Id`.
- Outbound B2BUA: `X-Aplisay-PhoneRegistration`, `X-Aplisay-Origin-Caller-Id`, `X-Aplisay-Call-Id`.

**Transfer**

- `canRefer` precedence: WebRTC=false → registration=true → `trunk.flags.canRefer` → false (missing).
- `forceBridged` (endpoint-level or per-call) overrides `canRefer`.
- REFER carries `Refer-Sub: false` and `Supported: norefersub`; agent does not consume NOTIFY.
- REFER URI: `tel:<number>` (SBC) or `sip:<number>@<registrar>;transport=...` (B2BUA).
- Blind-bridge uses `waitUntilAnswered`; original disconnects on bridge answer.

**Consultative**

- Consultation is private; mechanism is implementation choice.
- `transferPrompt` precedence: per-call > per-agent > built-in default; `${parentTranscript}` placeholder.
- Accept currently always blind-bridge (REFER not yet supported, may change); reject resumes original agent.
- `consultFeedback` exposes rejection reason to parent agent when true.

**Number handling**

- E.164 normalization with default-country setting.
- `agent.options.outboundCallFilter` regex gates outbound destinations.
- Caller-ID override on `transfer` requires user ownership.

## 7. Call lifecycle and disconnect taxonomy

A call has three lifecycle stages: **setup** (lookup, concurrency reservation, agent initialization), **run** (the active session — provider streaming, tools resolving, transfers handled), and **end** (cleanup). The contract below covers the obligations of each stage and the taxonomy of reasons a call can end.

### 7.1 Concurrency reservation

Every agent has a configurable concurrency cap. A slot must be reserved before a call enters the run stage:

- **Outbound (originate API)** — the slot is reserved before the worker is dispatched. Failure to reserve returns a busy/429 indication to the originator.
- **Inbound** — the slot is reserved during setup, before the agent session starts. Failure to reserve maps to a SIP busy cause on the inbound leg (see section 6).

The slot is held for the lifetime of the call and released exactly once at end, regardless of which terminal reason fires. Setup-phase failures must release the slot before returning.

### 7.2 Active-phase obligations

**`maxDuration` enforcement is mandatory.** Every implementation must enforce a configured maximum call duration. The configuration knob is `agent.options.maxDuration` (section 9). When exceeded, the call ends with `SESSION_TIMEOUT`.

**Active-participant tracking.** During a blind-bridge transfer, the "active" remote participant rotates from original to bridged when the bridged participant answers. The call ends when the currently-active remote participant disconnects. (See 6.9 for the transfer mechanics.)

**Disconnect detection without SIP signaling.** The agent must detect and end calls where the remote participant has disconnected without proper SIP signaling. The mechanism is an implementation choice — the LiveKit worker uses a 120-second watchdog poll over remote participants.

### 7.3 Disconnect reasons — core contract

Every implementation must surface these six reasons:

- **`ORIGINAL_PARTICIPANT`** — original caller hung up.
- **`BRIDGED_PARTICIPANT`** — bridged participant hung up after a successful blind-bridge transfer.
- **`AGENT_INITIATED_HANGUP`** — agent invoked the `hangup()` tool. The agent terminates its leg with SIP BYE; the upstream forwards to the caller. No additional Reason headers or cause codes are prescribed.
- **`SESSION_TIMEOUT`** — `maxDuration` exceeded.
- **`SESSION_CLOSED`** — the agent session closed (provider error, model overload, explicit close).
- **`UNCAUGHT_ERROR_RUNNING_AGENT`** — a top-level worker exception.

### 7.4 Disconnect reasons — handler-specific extensions

Handlers may extend the taxonomy with reasons not captured by the core set. The LiveKit handler currently emits `WATCHDOG_NO_PARTICIPANTS` for the watchdog-detected no-participants case. The long-term direction is to consolidate handler-specific reasons into the core contract; this document flags handler-specific extensions as transitional rather than permanent.

### 7.5 End-of-call cleanup

At call end the following steps must execute in order:

1. Stop the agent session — no further provider interactions.
2. POST `/api/agent-db/call/:id/end` with the disconnect reason and any unstreamed transaction logs. This releases the concurrency slot and persists the final call record. (See section 8.3.)
3. Finalize and upload the recording, if enabled. PUT recording metadata to `/api/agent-db/call/:id/recording`. (See sections 8.5 and 9.2.)
4. Flush invocation logs to `/api/agent-db/invocation-log`. (See sections 8.4 and 9.3.)
5. Tear down the call session and room.

Each step must be attempted regardless of prior-step failures. Step 2 is critical because it releases the concurrency slot — failures here should be retried briefly with backoff before proceeding. Steps 3 and 4 are best-effort; failures are logged and do not block teardown.

If the worker dies before delivering step 2 (process crash, unrecoverable network failure, retries exhausted), the concurrency slot would otherwise be leaked. Reclamation under that failure mode is the REST server's responsibility — TTL, lease, reaper, or equivalent — and is out of scope for this document. The contract a re-implementer must honor is best-effort delivery of step 2; the server side is responsible for ensuring slots cannot stay reserved forever.

As more handlers are added these cleanup steps are likely to be refactored into a shared library; the contract is the steps and their ordering, not any specific code path.

### 7.6 Contract summary

A re-implementer must honor:

- Three lifecycle stages — setup, run, end.
- Concurrency reservation: reserved before run-stage entry, released exactly once at end, busy/429 (or SIP busy cause) when unreservable.
- Mandatory `maxDuration` enforcement, mapped to `SESSION_TIMEOUT`.
- Active-participant tracking across blind-bridge transfers.
- Disconnect detection without proper SIP signaling (mechanism is implementation choice).
- Six core disconnect reasons (`ORIGINAL_PARTICIPANT`, `BRIDGED_PARTICIPANT`, `AGENT_INITIATED_HANGUP`, `SESSION_TIMEOUT`, `SESSION_CLOSED`, `UNCAUGHT_ERROR_RUNNING_AGENT`); handler-specific extensions are permitted but transitional.
- Cleanup ordering: stop session → end Call record → finalize recording → flush invocation logs → tear down. Each step attempted regardless of prior failures; the concurrency-release step is critical.

## 8. REST callback contract

The worker calls back into the `llm-agent` REST server for all persistence and lookup operations. This section is a compact reference: each endpoint is listed by URL, purpose, when called, and any error or idempotency semantics specific to it. For exact request and response field shapes, consult [api/api-doc.yaml](api/api-doc.yaml) — that schema is authoritative and may evolve.

### 8.1 Authentication and base URL

The worker authenticates by setting a custom HTTP header on every `/api/agent-db/*` request:

```
x-shared-token: <value>
```

The token value is sourced from the `SHARED_API_TOKEN` environment variable. The REST server base URL is sourced from `SERVICE_BASE_URI`. Both are required for normal operation. The header is omitted when the env var is unset; the REST server is responsible for enforcing its presence.

The header name (`x-shared-token`) and the env var names (`SHARED_API_TOKEN`, `SERVICE_BASE_URI`) are part of the current contract — any worker pointing at this REST server must use them. A re-implementer migrating both ends could rename them, but cross-implementation interoperability requires matching.

### 8.2 Lookup endpoints

Called during call setup to resolve the agent and its phone-number context. All are GET, read-only, idempotent.

- **`GET /api/agent-db/instance`** — resolve Instance (with embedded Agent) by `?instanceId=` or `?number=`.
- **`GET /api/agent-db/agent`** — resolve Agent by `?agentId=`. Used for fallback-agent loading (section 9).
- **`GET /api/agent-db/phone-endpoints`** — resolve PhoneEndpoint by `?number=&trunkId=` (trunk-based) or `?id=` (registration endpoint).

### 8.3 Call lifecycle endpoints

The three endpoints that drive the call lifecycle from section 7:

- **`POST /api/agent-db/call`** — create the call record. Does not reserve concurrency.
- **`POST /api/agent-db/call/:id/start`** — reserve the agent's concurrency slot. Returns `429` with body code `AGENT_CONCURRENCY_LIMIT_EXCEEDED` on busy; the inbound path maps this to a SIP busy cause (section 6).
- **`POST /api/agent-db/call/:id/end`** — end the call with a disconnect reason. Body may include batched transaction logs (when `streamLog` is false — see 8.4). Releases the concurrency slot.

Side effects: the REST server fires any configured `agent.options.callHook` callbacks based on the start and end events received here — the worker does not invoke callHooks directly.

### 8.4 Logging endpoints

Two endpoints capture call activity, distinguished by when they fire and what data they carry:

- **`POST /api/agent-db/transaction-log`** — per-event log post, used when `instance.streamLog === true`. Each entry has a `type` field capturing the kind of event (user transcript, agent transcript, function call, function result, status change, etc.), a `data` payload, and timing fields. When `streamLog === false`, transaction logs are instead batched into the body of `call/:id/end` (see 8.3). The choice between live-stream and batched lives at instance level.
- **`POST /api/agent-db/invocation-log`** — flush worker telemetry on shutdown. Body carries a log array and an optional subsystem identifier.

### 8.5 Recording metadata

- **`PUT /api/agent-db/call/:id/recording`** — body carries the recording ID (storage path) and an optional encryption key. Called once after recording finalization in cleanup (section 7.5). The storage backend itself is GCS — see 9.2 for the contract.

### 8.6 Provisioning workflow (handler-conditional)

Some handlers — including LiveKit — need their upstream platform to be configured for a phone number before the number can route calls (e.g. trunk numbers must be registered with the SIP service). This is handled out-of-band:

- The operator runs the agent in a dedicated **setup mode** (cron-driven, batch).
- The setup process walks the platform's phone-number database, provisions any unprovisioned numbers in the upstream platform, and PATCHes **`/api/agent-db/phone-endpoints/:number`** with `{ provisioned: true }` for each number it has configured.
- A handler-level config flag (forthcoming) tells the REST server whether the handler requires this provisioning workflow, so number-creation can short-circuit when not needed (e.g. handlers that talk directly to a PSTN provider with no per-number trunk configuration).

This workflow is part of the contract only for handlers that need it.

### 8.7 Errors and idempotency

- The only specific error code worth memorising is **`429` with body code `AGENT_CONCURRENCY_LIMIT_EXCEEDED`** on `call/:id/start`, mapped to SIP busy on inbound (section 6).
- Standard 4xx/5xx semantics apply elsewhere; clients should distinguish recoverable (5xx, network failures) from non-recoverable (4xx, client error) and act accordingly.
- The worker must attempt idempotency on key lifecycle calls — `call/:id/start`, `call/:id/end`, recording PUT, invocation-log POST — so transient-failure retries are safe. The REST server provides additional dedup protection.

### 8.8 Contract summary

A re-implementer must honor:

- **Auth** — `x-shared-token` header on every `/api/agent-db/*` request, value from `SHARED_API_TOKEN`. Base URL from `SERVICE_BASE_URI`.
- **Lookup** — instance, agent, phone-endpoints (GET, idempotent).
- **Call lifecycle** — create / start / end POSTs; `429 AGENT_CONCURRENCY_LIMIT_EXCEEDED` on busy.
- **Logging** — per-event `transaction-log` POST when `instance.streamLog === true`; otherwise batched into `call/:id/end`. Invocation-log POST flushed on shutdown.
- **Recording metadata** — PUT after upload; storage backend is implementation.
- **Provisioning** — PATCH `/phone-endpoints/:number` `{ provisioned: bool }` from a handler-conditional setup-mode batch run.
- **Idempotency** — worker attempts it on lifecycle calls; REST server provides dedup safety net.

## 9. Operational behavior

This section covers fallback and failover, recording, invocation logs, the configuration-override hierarchy, and the full reference catalog of agent options that affect runtime behavior.

### 9.1 Fallback and failover

Fallback configuration on an agent plays two roles:

1. **Same-handler runtime resilience** — try an alternate model or alternate agent if the primary fails to start.
2. **Cross-handler routing** — drive the upstream's decision about whether this handler should accept or reject a call.

Both effects come from the same `agent.options.fallback` configuration (`agent`, `model`, `number`).

#### Entry-time precedence

A handler "handles" a model when the model's leading scope (the `<handlername>:` prefix) matches the handler's `static name` from section 3.2.

On receiving a call, the handler must attempt to start the agent in this precedence order, considering only the levels it handles:

1. **`agent.modelName`** — if this handler handles it.
2. **`agent.options.fallback.model`** — if this handler handles it (and the prior level was either not handleable by this handler or its attempt failed).
3. **`agent.options.fallback.agent`'s `modelName`** — fetch the referenced fallback agent and check whether this handler handles its model.

At each handleable level, attempt to start the agent. If the attempt fails (provider error, model overload, agent setup error), fall through to the next handleable level.

Misconfigured or non-existent entries (lookup failures, malformed configurations) are treated as "this level is not handleable" — fall through. The handler must not loop, must not crash, and must not interfere with the upstream's retry path.

#### `fallback.number` as last resort

If no handleable level has succeeded (or all attempted levels failed), the handler blind-transfers the call to `agent.options.fallback.number`. This is the only fallback level that does not require successful agent startup.

`fallback.number` requires that the call has reached SIP signaling far enough to bridge a participant. If a setup-time failure happens before any SIP participant is established, rejection (below) is the only path available.

If `fallback.number` is not configured and all handleable levels have failed, the call ends cleanly with the appropriate disconnect reason from section 7.3 (typically `SESSION_CLOSED` or `UNCAUGHT_ERROR_RUNNING_AGENT`). Cross-handler rejection (below) applies only when this handler cannot handle any of the three precedence levels at all — not when handleable attempts have simply failed.

#### Cross-handler rejection

If this handler does not handle any of the three model levels above, it must reject the call so the upstream (SBC or B2BUA) can route it to a different handler endpoint. The rejection should be a server-failure (`5xx`) or temporarily-unavailable (`4xx`) response, chosen from whatever the framework permits — the LiveKit worker currently emits 488 on a thrown setup error.

What the upstream actually does on rejection — static fallback list, dynamic routing, etc. — is an operator concern outside the scope of this contract. The contract requires only that the handler signals failure cleanly so the upstream is free to retry elsewhere.

### 9.2 Recording

Recording is configured per-agent (overridable per-instance — see 9.4). When enabled, audio captured during the call is encrypted, uploaded to storage during cleanup, and the location is persisted via PUT `/api/agent-db/call/:id/recording` (section 8.5).

**Encryption and key handling.** When `agent.options.recording.key` is set, the recording is encrypted with a key derived from that value and the platform cannot decrypt it on the operator's behalf — users must decrypt client-side after download. When `key` is unset, the platform generates a per-call key internally so downloads return plaintext.

**Storage backend.** The current implementation uses Google Cloud Storage. GCS is part of the contract: other implementations should use the same mechanism rather than introducing alternative storage backends. As more handlers are added, the recording finalization, encryption and upload logic should be factored into a shared library; new implementations should refer to and reuse the LiveKit implementation rather than redoing it from scratch.

### 9.3 Invocation logs

The worker buffers structured logs during a call — provider activity, tool-call traces, error contexts, decision points — and flushes them on shutdown via POST `/api/agent-db/invocation-log` (section 8.4).

The buffer is process-wide; logs from concurrent calls interleave, and entries correlate by `callId`. Each batch may carry an optional `subsystem` identifier (e.g. `worker`, `transfer`, `recording`) so the REST server can partition them.

The contract is structured, callId-tagged, flushed-on-shutdown logging. Specific log shapes and field names are implementation choice.

### 9.4 Configuration override hierarchy

Configuration lives at two levels:

- **Agent** — defaults that apply to all calls handled by an agent.
- **Instance** — per-deployment overrides that take precedence over the agent defaults. "Listener" is a synonym for Instance in some API surfaces.

A subset of options supports Instance-level override (notably `recording`, `streamLog`, `callHook`); consult [api/api-doc.yaml](api/api-doc.yaml) for the authoritative list.

### 9.5 Agent options reference

The catalog below covers every option that affects runtime behavior. The "Level" column indicates where each option may be set; cross-refs point to the section where the option is discussed.

| Option | Level | Purpose | Section |
|---|---|---|---|
| `voiceMode` | Agent | Override mode selection (pipeline / realtime) | 4.1 |
| `stt` | Agent | STT configuration (vendor, language) | 4.3, 4.4 |
| `tts` | Agent | TTS configuration (vendor, voice, language) | 4.3, 4.4 |
| `vendorSpecific` | Agent | Free-form provider passthrough | 4.6 |
| `greeting` | Agent | Uninterruptible opening greeting (text or instructions) | 4.5 |
| `maxDuration` | Agent | Maximum call duration (mandatory enforcement) | 7.2 |
| `temperature` | Agent | LLM sampling temperature (applies in both pipeline and realtime modes) | 4.4 |
| `outboundCallFilter` | Agent | Anchored regex gating outbound destinations | 6.6 |
| `transferPrompt` | Agent | Default prompt for consultative TransferAgent | 6.10 |
| `recording.enabled` | Agent (Instance override) | Enable / disable call recording | 9.2 |
| `recording.key` | Agent (Instance override) | Client-provided encryption key | 9.2 |
| `fallback.agent` | Agent | Cross-handler / cross-model fallback agent ID | 9.1 |
| `fallback.model` | Agent | Same-agent fallback model | 9.1 |
| `fallback.number` | Agent | Last-resort blind-transfer destination | 9.1, 6.7 |
| `callHook` | Agent (Instance override) | Outbound webhook on call start/end (REST-server-driven) | 8.3 |
| `streamLog` | Instance | Live-stream transaction logs vs batch | 8.4 |

### 9.6 Contract summary

A re-implementer must honor:

- **Fallback precedence** — try `modelName` → `fallback.model` → `fallback.agent`'s `modelName`, considering only levels this handler handles. Fall through on failure to the next handleable level. `fallback.number` is the last resort once a SIP participant has been established.
- **Cross-handler rejection** — when no fallback level is handleable by this handler, reject with a `5xx` or `4xx` so the upstream can retry against another handler.
- **Recording** — encrypt and upload to GCS on cleanup; metadata persisted via the recording PUT. Encryption-key handling per `recording.key` (operator-decryptable when unset, client-decryptable when set). Recording logic is a refactor candidate for a shared library across handlers.
- **Invocation logs** — buffered worker telemetry, callId-tagged, flushed on shutdown.
- **Override hierarchy** — Agent (defaults) and Instance (per-deployment overrides). Consult `api-doc.yaml` for which options are overridable.
- **Agent options catalog** — see 9.5 for the full reference.

## 10. Known divergences and migration notes

This section consolidates places where the current implementation differs from the contract documented above, items slated for imminent development that the contract assumes, and forward-looking refactor intent. A re-implementer should treat the contract as authoritative and use this section as a guide to what to expect when reading the LiveKit code today.

### 10.1 Implementation diverges from contract

- **Pipeline registry duplication** (4.2) — the current LiveKit implementation maintains the pipeline-mode model registry in two places ([agents/livekit/lib/livekit-pipeline-model-ids.ts](agents/livekit/lib/livekit-pipeline-model-ids.ts) and `PIPELINE_MODEL_ROWS` in [lib/models/livekit.js](lib/models/livekit.js)) with comments warning them to be kept in sync. The contract is a single source of truth in the handler tree.
- **Cross-handler fallback** (9.1) — the contract is that if a handler does not handle any of `agent.modelName`, `fallback.model`, or `fallback.agent`'s `modelName`, it must reject the call and let the upstream retry against another handler. The current LiveKit worker may retry within itself regardless of whether a fallback model belongs to a different handler tree, which is wrong by the contract.

### 10.2 Slated for imminent development

- **Realtime output customisation** (4.3) — when `agent.options.tts.vendor` is set to a vendor different from the realtime provider's own, the realtime model should switch to text-output mode and a separate TTS handles audio out. Documented as contract; not yet wired in the LiveKit implementation.
- **REFER for consultative transfers** (6.10) — consultative-transfer accept is currently always blind-bridge. REFER support may be added later; the documented contract today is blind-bridge-only on accept.
- **Handler-level provisioning config flag** (8.6) — a forthcoming flag on the handler that tells the REST server whether the provisioning workflow is needed, so number-creation can short-circuit when not. Not yet implemented.

### 10.3 Future shared-library candidates

- **Recording library** (9.2) — recording finalization, encryption, and upload logic currently lives in the LiveKit handler only. Slated for refactor into a shared library as the next handler is built; GCS as the storage backend is contract.
- **Handler-specific disconnect reasons** (7.4) — `WATCHDOG_NO_PARTICIPANTS` is currently a LiveKit-specific reason outside the core contract. The long-term direction is to consolidate handler-specific reasons into the core taxonomy.

### 10.4 Naming legacy

- **`'realtime'` agent dispatch name** — the LiveKit worker registers under a dispatch agent name `'realtime'` that predates the addition of pipeline mode. The name does not reflect current capability and is not part of the contract a re-implementer needs to honor; flagged here for anyone reading the LiveKit handler code.
