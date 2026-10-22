import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { initializeLogger, llm } from "@livekit/agents";
import { AudioFrame, dispose } from "@livekit/rtc-node";
import * as el from "../lib/elevenlabs-agents.js";
import { ElevenLabsAgentsClient, ElevenLabsAgentsError, forgetKnownAgents } from "../lib/elevenlabs-agents-client.js";
import {
  ElevenLabsRealtimeModel,
  ElevenLabsRealtimeSession,
  toolSchemasOf,
} from "../lib/elevenlabs-realtime.js";
import { buildRealtimeLlmOptions, createVoiceModelAndSession } from "../lib/voice-session-factory.js";
import { externalTtsVendor, textOutputEnabled } from "../lib/realtime-tts.js";
import {
  ELEVENLABS_AGENT_LLMS,
  livekitModelIdFlags,
  livekitModelSupportsExternalTts,
  buildLivekitHandlerAllModels,
} from "../lib/livekit-model-registry.js";
import { resolveUsageVendors } from "../lib/usage-vendors.js";

// ElevenLabs Agents on the LiveKit worker, with no connection to ElevenLabs: the mapping,
// the REST client against a fake fetch, and the conversation against a stand-in socket.
// run: npx tsx --test test/elevenlabs-agents.test.ts

initializeLogger({ pretty: false, level: process.env.TEST_LOG || "fatal" });

// The resampler the audio test exercises starts the rtc-node FFI, which keeps the process alive.
after(() => dispose());

const ROW = "livekit:elevenlabs/gemini-2.5-flash";

const agentDef = (options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({
    id: "a1",
    userId: "u1",
    organisationId: "o1",
    modelName: ROW,
    name: "Sam",
    prompt: "You are Sam.",
    functions: [],
    options,
    ...extra,
  }) as any;

const toolOf = (description: string, parameters: Record<string, unknown> = { type: "object", properties: {} }, execute?: (args: any) => Promise<unknown>) =>
  llm.tool({ description, parameters: parameters as any, execute: execute ?? (async () => ({ ok: true })) });

const schemas = (): el.ToolSchema[] => [
  {
    name: "book_slot",
    description: "Book a slot",
    parameters: {
      properties: {
        when: { type: "string", description: "ISO date" },
        size: { type: "integer", description: "party size", required: true },
        kind: { type: "string", enum: ["lunch", "dinner"] },
        guests: { type: "array", items: { type: "string" } },
        contact: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
        odd: { description: "no type", source: "generated" },
      },
      required: ["when", "size"],
    },
  },
  { name: "hangup", description: "End the call", parameters: { type: "object", properties: {} } },
];

// --- the registry and the worker's tables -----------------------------------------------

test("one realtime row per LLM, with no text-output mode", () => {
  assert.deepEqual(
    ELEVENLABS_AGENT_LLMS.map(([id]) => id),
    ["gemini-2.5-flash", "gpt-5.4-mini", "claude-haiku-5-5", "claude-sonnet-5-5"],
  );
  for (const [id] of ELEVENLABS_AGENT_LLMS) {
    assert.deepEqual(livekitModelIdFlags[`elevenlabs/${id}`], { voiceStack: "realtime", audioModel: true, pipeline: false });
    assert.equal(livekitModelSupportsExternalTts(`elevenlabs/${id}`), false);
  }
  const row = buildLivekitHandlerAllModels().find(([id]) => id === "elevenlabs/gemini-2.5-flash");
  assert.equal(row?.[1], "ElevenLabs Agents, Gemini 2.5 Flash (Livekit realtime)");
  assert.equal(el.isElevenLabsModelName(ROW), true);
  assert.equal(el.isElevenLabsModelName("livekit:openai/gpt-realtime"), false);
  assert.equal(el.isElevenLabsModelName("pipecat:elevenlabs/gemini-2.5-flash"), false);
  assert.equal(el.elevenLabsLlm(ROW), "gemini-2.5-flash");
  assert.equal(el.elevenLabsLlm("elevenlabs/claude-haiku-5-5"), "claude-haiku-5-5");
});

test("elevenlabs is the rows' own voice, and the rows never run in text-output mode", () => {
  assert.equal(externalTtsVendor(agentDef({ tts: { vendor: "elevenlabs", voice: "v" } }), ROW), undefined);
  assert.equal(externalTtsVendor(agentDef({ tts: { vendor: "cartesia", voice: "v" } }), ROW), "cartesia");
  assert.equal(textOutputEnabled(agentDef({ tts: { vendor: "cartesia", voice: "v" } }), ROW), false);
  assert.equal(resolveUsageVendors(agentDef(), ROW).llm.vendor, "elevenlabs");
});

// --- tools and the hosted configuration -----------------------------------------------

test("client tools keep the schema ElevenLabs reads", () => {
  const tools = el.clientTools(schemas());
  assert.deepEqual(tools.map((t) => t.name), ["book_slot", "hangup"]);
  const book = tools[0] as any;
  assert.equal(book.type, "client");
  assert.equal(book.expects_response, true);
  assert.equal(book.response_timeout_secs, el.TOOL_RESPONSE_TIMEOUT_SECONDS);
  assert.deepEqual(book.parameters.required, ["when", "size"]);
  const props = book.parameters.properties;
  assert.deepEqual(props.when, { type: "string", description: "ISO date" });
  assert.deepEqual(props.size, { type: "integer", description: "party size" });
  assert.deepEqual(props.kind, { type: "string", enum: ["lunch", "dinner"], description: "" });
  assert.deepEqual(props.guests, { type: "array", items: { type: "string", description: "" }, description: "" });
  assert.deepEqual(props.contact.required, ["email"]);
  assert.deepEqual(props.odd, { type: "string", description: "no type" });
  assert.equal("parameters" in (tools[1] as any), false);
  assert.deepEqual(el.clientTools([{ name: "end_call", description: "" }, { name: "ok", description: "" }]).map((t) => t.name), ["ok"]);
});

test("the hosted configuration, the vendor block and the hash", () => {
  const config = el.agentConfig(agentDef({ temperature: 0.3, maxTokens: 400 }), { llm: "gemini-2.5-flash", toolSchemas: schemas() }) as any;
  const cc = config.conversation_config;
  assert.equal(cc.agent.prompt.llm, "gemini-2.5-flash");
  assert.equal(cc.agent.prompt.temperature, 0.3);
  assert.equal(cc.agent.prompt.max_tokens, 400);
  assert.equal(cc.agent.prompt.ignore_default_personality, true);
  assert.deepEqual(cc.agent.prompt.tools.map((t: any) => t.name), ["book_slot", "hangup"]);
  assert.deepEqual(cc.tts, { voice_id: el.ELEVENLABS_DEFAULT_VOICE, agent_output_audio_format: "pcm_24000" });
  assert.deepEqual(cc.asr, { user_input_audio_format: "pcm_16000" });
  assert.deepEqual(cc.turn, { turn_timeout: el.TURN_TIMEOUT_SECONDS });
  assert.equal(cc.conversation.max_duration_seconds, 7200);
  assert.deepEqual(config.platform_settings.auth, { enable_auth: true });
  assert.deepEqual(config.platform_settings.privacy, { record_voice: false, retention_days: 1 });
  assert.equal(config.platform_settings.overrides.conversation_config_override.agent.prompt.prompt, true);

  const vendor = agentDef({ vendorSpecific: { elevenlabs: { conversation_config: {
    turn: { turn_timeout: 12, turn_eagerness: "eager" },
    tts: { model_id: "eleven_turbo_v2_5", voice_id: "sneaky" },
    agent: { prompt: { llm: "gpt-4o", tools: [{}], reasoning_effort: "low" }, first_message: "Hi" },
    conversation: { text_only: true },
  } } } });
  const merged = el.agentConfig(vendor, { llm: "gemini-2.5-flash", toolSchemas: [] }) as any;
  assert.deepEqual(merged.conversation_config.turn, { turn_timeout: 12, turn_eagerness: "eager" });
  assert.equal(merged.conversation_config.tts.model_id, "eleven_turbo_v2_5");
  assert.equal(merged.conversation_config.tts.voice_id, el.ELEVENLABS_DEFAULT_VOICE);
  assert.equal(merged.conversation_config.agent.prompt.llm, "gemini-2.5-flash");
  assert.deepEqual(merged.conversation_config.agent.prompt.tools, []);
  assert.equal(merged.conversation_config.agent.prompt.reasoning_effort, "low");
  assert.equal(merged.conversation_config.agent.first_message, "");
  assert.equal("text_only" in merged.conversation_config.conversation, false);

  const base = el.configHash(el.agentConfig(agentDef(), { llm: "gemini-2.5-flash", toolSchemas: schemas() }));
  const same = el.configHash(el.agentConfig(
    agentDef({ tts: { voice: "other", language: "fr-FR", speed: 1.1 }, greeting: { text: "Hello" }, maxDuration: "600s" }),
    { llm: "gemini-2.5-flash", toolSchemas: schemas() },
  ));
  assert.equal(same, base);
  assert.notEqual(el.configHash(el.agentConfig(agentDef(), { llm: "gpt-5.4-mini", toolSchemas: schemas() })), base);
  assert.notEqual(el.configHash(el.agentConfig(agentDef(), { llm: "gemini-2.5-flash", toolSchemas: schemas().slice(0, 1) })), base);
  assert.notEqual(el.configHash(el.agentConfig(vendor, { llm: "gemini-2.5-flash", toolSchemas: schemas() })), base);
  assert.equal(base.length, 20);
  // the canonical form the Python twin hashes: sorted keys, no whitespace
  assert.equal(el.canonicalJson({ b: [1, { d: true, c: null }], a: "x" }), '{"a":"x","b":[1,{"c":null,"d":true}]}');
  const body = el.createBody(config, "staging:abc", { ELEVENLABS_AGENT_PREFIX: "staging" } as any) as any;
  assert.equal(body.name, "staging:abc");
  assert.deepEqual(body.tags, ["aplisay", "staging"]);
  assert.equal("_v" in body, false);
  assert.equal(el.agentName("abc", {} as any), "aplisay:abc");
});

test("per-conversation overrides, duration and the opening plan", () => {
  const overrides = el.conversationOverrides(
    agentDef({ tts: { voice: "v123", language: "fr-FR", speed: 1.5 }, maxDuration: "1800s" }),
    { systemPrompt: "Bonjour.", firstMessage: "Allo", maxDurationSecs: 1800 },
  ) as any;
  assert.deepEqual(overrides.agent, { prompt: { prompt: "Bonjour." }, first_message: "Allo", language: "fr" });
  assert.deepEqual(overrides.tts, { voice_id: "v123", speed: 1.2 });
  assert.deepEqual(overrides.conversation, { max_duration_seconds: 1860 });
  const plain = el.conversationOverrides(agentDef(), { systemPrompt: "", firstMessage: "" }) as any;
  assert.deepEqual(plain.agent, { prompt: { prompt: "" }, first_message: "" });
  assert.deepEqual(plain.tts, { voice_id: el.ELEVENLABS_DEFAULT_VOICE });
  assert.equal(plain.conversation.max_duration_seconds, 7200);
  assert.equal(el.clampDuration(undefined), 7200);
  assert.equal(el.clampDuration(10), 70);
  assert.equal(el.clampDuration(99999), 7200);
  assert.equal(el.maxDurationSeconds(agentDef({ maxDuration: "900s" })), 900);
  assert.equal(el.maxDurationSeconds(agentDef({ maxDuration: 120 })), 120);
  assert.equal(el.maxDurationSeconds(agentDef({ maxDuration: "soon" })), undefined);
  assert.deepEqual(el.openingPlan(agentDef({ greeting: { text: " Acme, Sam speaking. " } })), { firstMessage: "Acme, Sam speaking." });
  const instructed = el.openingPlan(agentDef({ greeting: { instructions: "Greet warmly in French." } }));
  assert.equal(instructed.firstMessage, "");
  assert.match(instructed.openingMessage!, /^\(Instruction from the system, not the caller: .*Greet warmly in French\./);
  assert.match(el.openingPlan(agentDef()).openingMessage!, /Greet the caller/);
  const handover = el.openingPlan(agentDef({ greeting: { text: "Hello" } }), "Introduce yourself.");
  assert.equal(handover.firstMessage, "");
  assert.match(handover.openingMessage!, /Introduce yourself\./);
  assert.equal(el.isDtmfText("12#"), true);
  assert.equal(el.isDtmfText("what time is it"), false);
  assert.equal(el.stripAudioTags("[warm] Bonjour, comment allez-vous?"), "Bonjour, comment allez-vous?");
  assert.equal(el.stripAudioTags("Ref [REF-42] booked [laughs] now."), "Ref [REF-42] booked now.");
});

// --- the REST client ---------------------------------------------------------------------

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (handler: Handler) => ((input: any, init: any) => Promise.resolve(handler(new URL(String(input)), init))) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the client finds an agent by name, caches it, creates on a miss and signs the URL", async (t) => {
  t.after(forgetKnownAgents);
  forgetKnownAgents();
  const env = { ELEVENLABS_AGENT_PREFIX: "t" } as any;
  const config = el.agentConfig(agentDef(), { llm: "gemini-2.5-flash", toolSchemas: schemas() });
  const name = el.agentName(el.configHash(config), env);
  process.env.ELEVENLABS_AGENT_PREFIX = "t";
  t.after(() => delete process.env.ELEVENLABS_AGENT_PREFIX);
  const calls: string[] = [];
  const found = new ElevenLabsAgentsClient("key", { baseUrl: "https://el.test", fetchImpl: fakeFetch((url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    assert.equal((init.headers as any)["xi-api-key"], "key");
    assert.equal(url.searchParams.get("search"), name);
    return json(200, { agents: [{ agent_id: "other", name: `${name}x` }, { agent_id: "agent_1", name }], has_more: false });
  }) });
  assert.equal(await found.ensureAgent(config), "agent_1");
  assert.equal(await found.ensureAgent(config), "agent_1");
  assert.deepEqual(calls, ["GET /v1/convai/agents"]);

  forgetKnownAgents();
  const created: any[] = [];
  const miss = new ElevenLabsAgentsClient("key", { baseUrl: "https://el.test", fetchImpl: fakeFetch((url, init) => {
    if (init.method === "GET" && url.pathname === "/v1/convai/agents") return json(200, { agents: [], has_more: false });
    if (init.method === "POST" && url.pathname === "/v1/convai/agents/create") {
      created.push(JSON.parse(String(init.body)));
      return json(200, { agent_id: "agent_new" });
    }
    if (url.pathname === "/v1/convai/conversation/get-signed-url") {
      assert.equal(url.searchParams.get("agent_id"), "agent_new");
      return json(200, { signed_url: "wss://el.test/conv?token=1" });
    }
    return json(500, {});
  }) });
  assert.deepEqual(await miss.conversationUrl(config), { agentId: "agent_new", url: "wss://el.test/conv?token=1" });
  assert.equal(created.length, 1);
  assert.equal(created[0].name, name);
  assert.deepEqual(created[0].tags, ["aplisay", "t"]);
  assert.equal(created[0].conversation_config.agent.prompt.tools[0].name, "book_slot");
  assert.equal("_v" in created[0], false);
});

test("a deleted agent is recreated once, errors carry the status, tool deletes are forced", async (t) => {
  t.after(forgetKnownAgents);
  forgetKnownAgents();
  const config = el.agentConfig(agentDef(), { llm: "gemini-2.5-flash", toolSchemas: [] });
  let created = 0;
  let lookups = 0;
  const client = new ElevenLabsAgentsClient("key", { baseUrl: "https://el.test", fetchImpl: fakeFetch((url, init) => {
    if (url.pathname === "/v1/convai/conversation/get-signed-url") {
      return url.searchParams.get("agent_id") === "agent_stale" ? json(404, { detail: "gone" }) : json(200, { signed_url: "wss://ok" });
    }
    if (init.method === "GET" && url.pathname === "/v1/convai/agents") {
      // The stale agent is listed once (it was deleted behind the cache); the retry finds nothing.
      lookups += 1;
      return json(200, { agents: lookups === 1 ? [{ agent_id: "agent_stale", name: el.agentName(el.configHash(config)) }] : [], has_more: false });
    }
    if (url.pathname === "/v1/convai/agents/create") {
      created += 1;
      return json(200, { agent_id: "agent_fresh" });
    }
    if (url.pathname.startsWith("/v1/convai/tools/")) {
      assert.equal(url.searchParams.get("force"), "true");
      return url.pathname.endsWith("busy") ? json(409, { detail: "in use" }) : new Response(null, { status: 204 });
    }
    return json(422, { detail: [{ msg: "Max duration in seconds has to be between 60 and 7200" }] });
  }) });
  assert.deepEqual(await client.conversationUrl(config), { agentId: "agent_fresh", url: "wss://ok" });
  assert.equal(created, 1);
  assert.equal(lookups, 2);
  assert.equal(await client.deleteTool("tool_free"), true);
  assert.equal(await client.deleteTool("tool_busy"), false);
  const refused = new ElevenLabsAgentsClient("key", { baseUrl: "https://el.test", fetchImpl: fakeFetch(() =>
    json(422, { detail: [{ msg: "Max duration in seconds has to be between 60 and 7200" }] })) });
  await assert.rejects(refused.createAgent({ name: "x" }), (e: any) => e instanceof ElevenLabsAgentsError && e.status === 422 && /7200/.test(e.message));
});

// --- the conversation -----------------------------------------------------------------

const b64 = (bytes: number, fill = 1) => Buffer.alloc(bytes, fill).toString("base64");
const audio = (eventId: number, bytes = 960) => ({ type: "audio", audio_event: { audio_base_64: b64(bytes), event_id: eventId } });
const response = (eventId: number, text: string) => ({ type: "agent_response", agent_response_event: { agent_response: text, event_id: eventId } });
const complete = (eventId: number) => ({ type: "agent_response_complete", agent_response_complete_event: { event_id: eventId } });

/** A session joined to a stand-in ElevenLabs over a local socket. */
async function liveSession(t: TestContext, agent: any, tools: Record<string, any>, opts: Record<string, unknown> = {}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const { port } = wss.address() as AddressInfo;
  const client = { conversationUrl: async () => ({ agentId: "agent_x", url: `ws://127.0.0.1:${port}/` }) } as unknown as ElevenLabsAgentsClient;
  t.after(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  const options = buildRealtimeLlmOptions(ROW, agent, "call-1", opts as any);
  const model = new ElevenLabsRealtimeModel({ ...options, apiKey: "key", client, silenceFillMs: 50, replyTimeoutMs: 300 } as any);
  const connected = once(wss, "connection") as Promise<[WebSocket]>;
  const session = model.session();
  const received: any[] = [];
  const events: Record<string, any[]> = { started: [], stopped: [], transcripts: [], generations: [], errors: [] };
  session.on("input_speech_started", (e) => events.started.push(e));
  session.on("input_speech_stopped", (e) => events.stopped.push(e));
  session.on("input_audio_transcription_completed", (e) => events.transcripts.push(e));
  session.on("generation_created", (e) => events.generations.push(e));
  session.on("error", (e) => events.errors.push(e));
  await session.updateInstructions(agent.prompt);
  await session.updateChatCtx(new llm.ChatContext());
  await session.updateTools(new llm.ToolContext(tools));
  const [socket] = await connected;
  socket.on("message", (data) => received.push(JSON.parse(data.toString())));
  // the initiation message, then the metadata back
  await waitFor(() => received.length >= 1);
  const send = (message: object) => socket.send(JSON.stringify(message));
  send({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
    conversation_id: "conv_1", agent_output_audio_format: "pcm_24000", user_input_audio_format: "pcm_16000" } });
  await waitFor(() => session.conversationId === "conv_1");
  return { model, session, socket, received, events, send };
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Read every item of a generation's message and function streams. */
async function drain(ev: llm.GenerationCreatedEvent) {
  const messages: any[] = [];
  for await (const m of ev.messageStream as any) {
    const texts: string[] = [];
    const frames: AudioFrame[] = [];
    const [textDone, audioDone] = [
      (async () => { for await (const tx of m.textStream as any) texts.push(typeof tx === "string" ? tx : tx.text); })(),
      (async () => { for await (const f of m.audioStream as any) frames.push(f); })(),
    ];
    await Promise.all([textDone, audioDone]);
    messages.push({ messageId: m.messageId, texts, frames, modalities: await m.modalities });
  }
  const functions: any[] = [];
  for await (const f of ev.functionStream as any) functions.push(f);
  return { messages, functions };
}

test("the conversation opens with the prompt, greeting and voice as overrides, and the opening message when there is no greeting text", async (t) => {
  const { session, received, send } = await liveSession(t, agentDef({ greeting: { text: "Acme, Sam speaking." }, tts: { voice: "v9" } }), { hangup: toolOf("hang up") });
  const init = received[0];
  assert.equal(init.type, "conversation_initiation_client_data");
  assert.deepEqual(init.conversation_config_override.agent, { prompt: { prompt: "You are Sam." }, first_message: "Acme, Sam speaking." });
  assert.deepEqual(init.conversation_config_override.tts, { voice_id: "v9" });
  assert.equal(init.conversation_config_override.conversation.max_duration_seconds, 7200);
  assert.equal(session.agentId, "agent_x");
  assert.equal((session.config as any).conversation_config.agent.prompt.tools[0].name, "hangup");
  // no opening message with a verbatim greeting; silence starts flowing once ready
  await waitFor(() => received.some((m) => "user_audio_chunk" in m));
  assert.equal(received.some((m) => m.type === "user_message"), false);
  send({ type: "ping", ping_event: { event_id: 7, ping_ms: 100 } });
  await waitFor(() => received.some((m) => m.type === "pong"));
  assert.deepEqual(received.find((m) => m.type === "pong"), { type: "pong", event_id: 7 });
  await session.close();

  const instructed = await liveSession(t, agentDef({ greeting: { instructions: "Say bonjour." } }), { hangup: toolOf("hang up") });
  await waitFor(() => instructed.received.some((m) => m.type === "user_message"));
  const opening = instructed.received.find((m) => m.type === "user_message");
  assert.match(opening.text, /Say bonjour\./);
  assert.equal(instructed.received[0].conversation_config_override.agent.first_message, "");
  await instructed.session.close();

  const handover = await liveSession(t, agentDef({ greeting: { text: "Hello" } }), { hangup: toolOf("hang up") }, { opening: "Introduce yourself briefly." });
  await waitFor(() => handover.received.some((m) => m.type === "user_message"));
  assert.match(handover.received.find((m) => m.type === "user_message").text, /Introduce yourself briefly\./);
  assert.equal(handover.received[0].conversation_config_override.agent.first_message, "");
  await handover.session.close();
});

test("a reply is one generation: its text once, 20 ms audio frames, closed when complete", async (t) => {
  const { session, events, send } = await liveSession(t, agentDef(), { hangup: toolOf("hang up") });
  send(response(3, "[warm] Hello there."));
  send(audio(3, 1920));
  send(audio(3, 960));
  await waitFor(() => events.generations.length === 1);
  const ev = events.generations[0];
  assert.equal(ev.userInitiated, false);
  send(complete(3));
  const { messages, functions } = await drain(ev);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].texts, ["Hello there."]);
  assert.deepEqual(messages[0].modalities, ["text", "audio"]);
  assert.equal(messages[0].frames.length, 3);
  assert.equal(messages[0].frames[0].sampleRate, 24000);
  assert.equal(messages[0].frames[0].samplesPerChannel, 480);
  assert.equal(functions.length, 0);
  // a reply whose audio arrives before its text still carries the text
  send(audio(4, 960));
  send(response(4, "Second."));
  send(complete(4));
  await waitFor(() => events.generations.length === 2);
  const second = await drain(events.generations[1]);
  assert.deepEqual(second.messages[0].texts, ["Second."]);
  // a text-only reply still becomes a generation
  send(response(5, "Noted."));
  send(complete(5));
  await waitFor(() => events.generations.length === 3);
  const third = await drain(events.generations[2]);
  assert.deepEqual(third.messages[0].texts, ["Noted."]);
  assert.equal(third.messages[0].frames.length, 0);
  await session.close();
});

test("an interruption raises the speech events and ends the generation; a new reply starts another", async (t) => {
  const { session, events, send } = await liveSession(t, agentDef(), { hangup: toolOf("hang up") });
  send(response(3, "I cannot tell long stories."));
  send(audio(3));
  await waitFor(() => events.generations.length === 1);
  send({ type: "interruption", interruption_event: { event_id: 4 } });
  send({ type: "agent_response_correction", agent_response_correction_event: { original_agent_response: "I cannot tell long stories.", corrected_agent_response: "I cannot...", event_id: 3 } });
  await waitFor(() => events.started.length === 1);
  assert.equal(events.stopped.length, 1);
  assert.deepEqual(events.stopped[0], { userTranscriptionEnabled: false });
  const first = await drain(events.generations[0]);
  assert.deepEqual(first.messages[0].texts, ["I cannot tell long stories."]);
  send(response(6, "Paris is cloudy."));
  send(audio(6));
  await waitFor(() => events.generations.length === 2);
  send(complete(6));
  const second = await drain(events.generations[1]);
  assert.deepEqual(second.messages[0].texts, ["Paris is cloudy."]);
  await session.close();
});

test("user transcripts become final transcription events; echoes of injected text are dropped", async (t) => {
  const { session, events, received, send } = await liveSession(t, agentDef({ greeting: { text: "Hi" } }), { hangup: toolOf("hang up") });
  send({ type: "user_transcript", user_transcription_event: { user_transcript: "What time is it?", event_id: 2 } });
  await waitFor(() => events.transcripts.length === 1);
  assert.equal(events.transcripts[0].transcript, "What time is it?");
  assert.equal(events.transcripts[0].isFinal, true);
  // keypad digits arrive as a user chat message (generateReply({ userInput }))
  const ctx = session.chatCtx;
  const digits = ctx.addMessage({ role: "user", content: "12#" });
  await session.updateChatCtx(ctx);
  await waitFor(() => received.some((m) => m.type === "user_message"));
  assert.deepEqual(received.find((m) => m.type === "user_message"), { type: "user_message", text: "12#", source_medium: "dtmf" });
  // ... and again on the next update is not sent twice
  await session.updateChatCtx(ctx);
  assert.equal(received.filter((m) => m.type === "user_message").length, 1);
  send({ type: "user_transcript", user_transcription_event: { user_transcript: "12#", event_id: 3 } });
  send({ type: "user_transcript", user_transcription_event: { user_transcript: "12#", event_id: 4 } });
  await waitFor(() => events.transcripts.length === 2);
  assert.equal(events.transcripts[1].transcript, "12#");
  // a transcript the SDK turns into a chat message is not sent back as text
  const withAudio = session.chatCtx;
  withAudio.addMessage({ role: "user", content: "What time is it?", id: events.transcripts[0].itemId });
  await session.updateChatCtx(withAudio);
  assert.equal(received.filter((m) => m.type === "user_message").length, 1);
  assert.ok(digits.id);
  await session.close();
});

test("generateReply sends the instruction as a user-side message and resolves on the next generation", async (t) => {
  const { session, received, send } = await liveSession(t, agentDef({ greeting: { text: "Hi" } }), { hangup: toolOf("hang up") });
  const reply = session.generateReply("Speak the following message verbatim: Are you still there?");
  await waitFor(() => received.some((m) => m.type === "user_message"));
  const message = received.find((m) => m.type === "user_message");
  assert.match(message.text, /^\(Instruction from the system, not the caller: Speak the following message verbatim: Are you still there\?\)$/);
  assert.equal("source_medium" in message, false);
  send(response(9, "Are you still there?"));
  send(audio(9));
  const ev = await reply;
  assert.equal(ev.userInitiated, true);
  send(complete(9));
  const { messages } = await drain(ev);
  assert.deepEqual(messages[0].texts, ["Are you still there?"]);
  // a reply the agent never makes resolves with an empty generation after the timeout
  const silent = await session.generateReply("Say nothing.");
  const drained = await drain(silent);
  assert.equal(drained.messages.length, 0);
  await session.close();
});

test("a tool call runs the session's tool and the result goes back once", async (t) => {
  const calls: any[] = [];
  const tools = {
    book_slot: toolOf("book", { type: "object", properties: { when: { type: "string" } } }, async (args) => {
      calls.push(args);
      return { ok: true, ref: "B42" };
    }),
    explode: toolOf("explode", { type: "object", properties: {} }, async () => {
      throw new Error("boom");
    }),
  };
  const { session, received, send } = await liveSession(t, agentDef(), tools);
  assert.deepEqual(toolSchemasOf(session.tools).map((s) => s.name), ["book_slot", "explode"]);
  send({ type: "client_tool_call", client_tool_call: { tool_name: "book_slot", tool_call_id: "book_slot_1", parameters: { when: "2026-11-01" }, expects_response: true } });
  await waitFor(() => received.some((m) => m.type === "client_tool_result"));
  assert.deepEqual(calls, [{ when: "2026-11-01" }]);
  assert.deepEqual(received.find((m) => m.type === "client_tool_result"), {
    type: "client_tool_result", tool_call_id: "book_slot_1", result: '{"ok":true,"ref":"B42"}', is_error: false,
  });
  send({ type: "client_tool_call", client_tool_call: { tool_name: "explode", tool_call_id: "explode_1", parameters: {}, expects_response: true } });
  await waitFor(() => received.filter((m) => m.type === "client_tool_result").length === 2);
  const failed = received.filter((m) => m.type === "client_tool_result")[1];
  assert.equal(failed.is_error, true);
  assert.match(failed.result, /boom/);
  send({ type: "client_tool_call", client_tool_call: { tool_name: "missing", tool_call_id: "missing_1", parameters: {}, expects_response: true } });
  await waitFor(() => received.filter((m) => m.type === "client_tool_result").length === 3);
  assert.equal(received.filter((m) => m.type === "client_tool_result")[2].is_error, true);
  await session.close();
});

test("caller audio is resampled to 16 kHz and sent in 100 ms chunks, with silence filling the gaps", async (t) => {
  const { session, received } = await liveSession(t, agentDef(), { hangup: toolOf("hang up") });
  const before = received.filter((m) => "user_audio_chunk" in m).length;
  // 20 ms frames at 24 kHz
  for (let i = 0; i < 20; i++) {
    session.pushAudio(new AudioFrame(new Int16Array(480).fill(1000), 24000, 1, 480));
  }
  await waitFor(() => received.filter((m) => "user_audio_chunk" in m && !/^AAAA/.test(m.user_audio_chunk)).length >= 2);
  const spoken = received.filter((m) => "user_audio_chunk" in m && !/^AAAA/.test(m.user_audio_chunk));
  for (const chunk of spoken) assert.equal(Buffer.from(chunk.user_audio_chunk, "base64").length, 3200);
  // silence keeps flowing while the caller says nothing
  await new Promise((r) => setTimeout(r, 160));
  const silence = received.filter((m) => "user_audio_chunk" in m && /^AAAA/.test(m.user_audio_chunk));
  assert.ok(silence.length >= 2, `silence chunks: ${silence.length}`);
  assert.equal(Buffer.from(silence[0].user_audio_chunk, "base64").length, 1600);
  assert.ok(received.length > before);
  await session.close();
});

test("the provider closing the socket reports provider-ended on the primary session only", async (t) => {
  const { model, session, socket, events } = await liveSession(t, agentDef(), { hangup: toolOf("hang up") });
  const ended: any[] = [];
  model.setProviderEndedCallback((info) => ended.push(info));
  const consult = model.session();
  socket.close(1011, "server going away");
  await waitFor(() => ended.length === 1);
  assert.deepEqual(ended[0], { code: 1011, reason: "server going away" });
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].recoverable, false);
  // a consult session's end is nobody's business
  await consult.close();
  await session.close();
  assert.equal(ended.length, 1);
});

test("the factory builds an ElevenLabs model from the row, with the agent and no greeting flip", async () => {
  process.env.ELEVENLABS_API_KEY ??= "test-key";
  const agent = agentDef({ greeting: { text: "Hello" }, tts: { voice: "v1", speed: 1.1 } });
  const options = buildRealtimeLlmOptions(ROW, agent, "call-1", { opening: "Carry on." });
  assert.equal(options.model, "gemini-2.5-flash");
  assert.equal(options.voice, "v1");
  assert.equal(options.agent, agent);
  assert.equal(options.opening, "Carry on.");
  assert.equal(typeof options.apiKey, "string");
  assert.equal("ttsSpeed" in options, false);
  const { session } = createVoiceModelAndSession({
    voiceMode: "realtime", modelName: ROW, agent, call: { id: "call-1", metadata: {} } as any,
    tools: new llm.ToolContext({ hangup: toolOf("hang up") }),
  });
  assert.ok((session as any).llm instanceof ElevenLabsRealtimeModel);
  assert.equal(((session as any).llm as ElevenLabsRealtimeModel).model, "gemini-2.5-flash");
  assert.ok(ElevenLabsRealtimeSession);
  await (session as any).close();
});
