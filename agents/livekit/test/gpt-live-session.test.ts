import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ReadableStream } from "node:stream/web";
import { initializeLogger, llm } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import {
  BACKEND_TOOL_POLICY,
  DELEGATION_FAILED_COMMENTARY,
  DELEGATION_STRANDED_COMMENTARY,
  NO_ANSWER_COMMENTARY,
  VOICE_DELEGATION_POLICY,
  type GptLivePrepared,
} from "../lib/gpt-live.js";
import {
  GptLiveRealtimeModel,
  armDelegationRecovery,
  attachClientDelegation,
  gptLiveUsageBackend,
} from "../lib/gpt-live-model.js";
import { createVoiceModelAndSession } from "../lib/voice-session-factory.js";
import { resolveUsageVendors } from "../lib/usage-vendors.js";
import { makeMetricsMeter } from "../lib/usage-meter.js";
import { isOpenAIRealtime, speakInactivityMessage } from "../lib/speak-text.js";
import { textOutputEnabled } from "../lib/realtime-tts.js";
import {
  livekitModelIdFlags,
  livekitModelSupportsDelegation,
  livekitModelSupportsExternalTts,
} from "../lib/livekit-model-registry.js";

// The GPT-Live session as the worker builds and runs it, with no connection to OpenAI.
// run: npx tsx --test test/gpt-live-session.test.ts

initializeLogger({ pretty: false, level: "fatal" });
process.env.OPENAI_API_KEY ??= "test-key";

const GPT_LIVE = "livekit:openai/gpt-live-1";

const voiceAgent = (options: Record<string, unknown> = {}) =>
  ({
    id: "voice-1",
    organisationId: "org-1",
    modelName: GPT_LIVE,
    prompt: "You are Sam.",
    functions: [],
    keys: [],
    options,
  }) as any;

const toolOf = (description: string) =>
  llm.tool({ description, parameters: { type: "object", properties: {} }, execute: async () => description });

const build = (agent: any, prepared?: GptLivePrepared, tools = new llm.ToolContext({ hangup: toolOf("hang up") })) =>
  createVoiceModelAndSession({
    voiceMode: "realtime",
    modelName: GPT_LIVE,
    agent,
    call: { id: "call-1", metadata: {} } as any,
    tools,
    gptLive: prepared,
  });

/** The GPTLiveModel options the factory chose. */
const liveOptions = (session: any) => (session.llm as GptLiveRealtimeModel).duplexModel as openai.realtime.GPTLiveModel;

test("the registry row: realtime, no text output, takes a delegate", () => {
  assert.deepEqual(livekitModelIdFlags["openai/gpt-live-1"], {
    voiceStack: "realtime",
    audioModel: true,
    pipeline: false,
    externalTts: false,
    delegation: true,
  });
  assert.equal(livekitModelSupportsDelegation("openai/gpt-live-1"), true);
  assert.equal(livekitModelSupportsDelegation("openai/gpt-realtime"), false);
  assert.equal(livekitModelSupportsExternalTts("openai/gpt-live-1"), false);
  assert.equal(livekitModelSupportsExternalTts("openai/gpt-realtime"), true);
});

test("the factory builds a synthetic-backend session from the voice agent alone", () => {
  const { session, model } = build(voiceAgent({ effort: "low", maxTokens: 300 }));
  assert.ok(session.llm instanceof GptLiveRealtimeModel);
  const opts = liveOptions(session)._opts;
  assert.equal(opts.model, "gpt-live-1");
  assert.equal(opts.voice, "marin");
  assert.equal(opts.delegation, "responses");
  assert.equal(opts.responsesOptions.model, "gpt-5.6-luna");
  assert.deepEqual(opts.responsesOptions.reasoning, { effort: "low" });
  assert.equal(opts.responsesOptions.maxOutputTokens, 300);
  assert.equal(
    opts.responsesOptions.instructions,
    `You are Sam.\n\n${BACKEND_TOOL_POLICY}\n\nTools available to you: hangup.`,
  );
  assert.equal(model.instructions, `You are Sam.\n\n${VOICE_DELEGATION_POLICY}`);
  assert.deepEqual(Object.keys(model.toolCtx.functionTools), ["hangup"]);
  assert.deepEqual(gptLiveUsageBackend(session.llm), { vendor: "openai", detail: "openai/gpt-5.6-luna" });
  // Explicit false: the SDK would otherwise add a VAD and a cloud turn detector.
  assert.equal(session.vad, undefined);
});

// docs/custom-voices.md: the API server adds `customVoice` when options.tts.voice is one of
// the organisation's ready voices.
const BRIGHTON = {
  id: "6f1c0b7e-0d3a-4c5e-9a43-1f1d2b3c4d5e",
  vendor: "openai",
  method: "prompt",
  voice: "voice_123abc",
  name: "Brighton concierge",
  prompt: "A warm, unhurried woman in her forties.",
  locale: "en-GB",
};
const withCustomVoice = (voice: string, cv: unknown) => ({ ...voiceAgent({ tts: { voice } }), customVoice: cv }) as any;

test("a custom voice is sent as { id }, and its description joins the voice instructions", () => {
  const { session, model } = build(withCustomVoice("voice_123abc", BRIGHTON));
  assert.deepEqual(liveOptions(session)._opts.voice, { id: "voice_123abc" });
  assert.equal(
    model.instructions,
    `You are Sam.\n\nYour speaking voice: A warm, unhurried woman in her forties.\n\n${VOICE_DELEGATION_POLICY}`,
  );
});

test("a custom voice the server did not resolve: the default voice, and no voice line", () => {
  const { session, model } = build(withCustomVoice("voice_gone99", null));
  assert.equal(liveOptions(session)._opts.voice, "marin");
  assert.equal(model.instructions, `You are Sam.\n\n${VOICE_DELEGATION_POLICY}`);
});

test("a declared OpenAI delegate: its model, prompt and settings are the backend", () => {
  const delegate = {
    id: "d-1",
    type: "text",
    modelName: "text:openai/gpt-5.6-terra",
    prompt: "You book appointments.",
    options: { effort: "medium" },
  } as any;
  const tools = new llm.ToolContext({ get_slots: toolOf("slots"), hangup: toolOf("hang up") });
  const { session, model } = build(
    voiceAgent({ tts: { voice: "cedar" } }),
    { spec: { agent: delegate, synthetic: false, mode: "responses" }, tools },
  );
  const opts = liveOptions(session)._opts;
  assert.equal(opts.voice, "cedar");
  assert.equal(opts.responsesOptions.model, "gpt-5.6-terra");
  assert.deepEqual(opts.responsesOptions.reasoning, { effort: "medium" });
  assert.match(opts.responsesOptions.instructions!, /^You book appointments\.\n\n/);
  assert.match(opts.responsesOptions.instructions!, /Tools available to you: get_slots, hangup\.$/);
  assert.deepEqual(Object.keys(model.toolCtx.functionTools).sort(), ["get_slots", "hangup"]);
  assert.deepEqual(gptLiveUsageBackend(session.llm), { vendor: "openai", detail: "openai/gpt-5.6-terra" });
});

test("client mode: no tools on the voice session and no backend options", () => {
  const delegate = { id: "d-2", type: "text", modelName: "text:anthropic/claude-sonnet-5", prompt: "x" } as any;
  const { session, model } = build(voiceAgent(), {
    spec: { agent: delegate, synthetic: false, mode: "client" },
    tools: llm.ToolContext.empty(),
  });
  const opts = liveOptions(session)._opts;
  assert.equal(opts.delegation, "client");
  assert.deepEqual(opts.responsesOptions, {});
  assert.equal(model.toolCtx.flatten().length, 0);
});

test("vendorSpecific names another backend model: the backend and the usage rows follow it", () => {
  const { session } = build(voiceAgent({ vendorSpecific: { openai: { live: { delegation: { responses: { model: "gpt-5.6-sol" } } } } } }));
  assert.equal(liveOptions(session)._opts.responsesOptions.model, "gpt-5.6-sol");
  assert.deepEqual(gptLiveUsageBackend(session.llm), { vendor: "openai", detail: "openai/gpt-5.6-sol" });
});

/** A stand-in for the plugin's GPTLiveSession, recording what the worker sends it. */
class FakeLiveSession extends EventEmitter {
  audioStream = new ReadableStream({ start() {} });
  sent: Record<string, any>[] = [];
  commentary: [string, { delegationId?: string | null } | undefined][] = [];
  sessionStartEvent() {
    return { type: "session.start", session: { model: "gpt-live-1", audio: { output: { voice: "marin" } } } };
  }
  queueEvent(event: Record<string, any>, replayOnReconnect: boolean) {
    this.sent.push({ ...event, replayOnReconnect });
  }
  sendEvent(event: Record<string, any>) {
    this.sent.push(event);
  }
  appendCommentary(text: string, options?: { delegationId?: string | null }) {
    this.commentary.push([text, options]);
  }
  async close() {}
}

class FakeLiveModel {
  capabilities = { userTranscription: true, autoToolReplyGeneration: true };
  sessions: FakeLiveSession[] = [];
  model = "gpt-live-1";
  provider = "api.openai.com";
  label() {
    return "GPTLiveModel";
  }
  audioGate() {
    return undefined;
  }
  session() {
    const s = new FakeLiveSession();
    this.sessions.push(s);
    return s;
  }
  async close() {}
}

const adapterOver = (fake: FakeLiveModel, overrides: Record<string, unknown> = {}) =>
  new GptLiveRealtimeModel(fake as unknown as openai.realtime.GPTLiveModel, {
    overrides,
    usageBackend: { vendor: "openai", detail: "openai/gpt-5.6-luna" },
    recovery: true,
  });

test("vendorSpecific.openai.live wins in session.start", async () => {
  const fake = new FakeLiveModel();
  const session = adapterOver(fake, { audio: { output: { voice: "custom-1" } }, store: false }).session();
  const start = (fake.sessions[0] as any).sessionStartEvent();
  assert.deepEqual(start.session, { model: "gpt-live-1", audio: { output: { voice: "custom-1" } }, store: false });
  await session.close();
});

test("the provider ending the caller's session ends the call; a consult session or our own close does not", async () => {
  const fake = new FakeLiveModel();
  const model = adapterOver(fake);
  const ended: unknown[] = [];
  model.setProviderEndedCallback((info) => ended.push(info));
  const caller = model.session();
  const consult = model.session();
  // AgentSession listens for these in the worker.
  caller.on("error", () => {});
  consult.on("error", () => {});
  const [callerLive, consultLive] = fake.sessions;
  consultLive!.emit("openai_server_event_received", { type: "session.closed", reason: "expired" });
  callerLive!.emit("openai_server_event_received", { type: "session.closed", reason: "close_requested" });
  assert.deepEqual(ended, []);
  callerLive!.emit("openai_server_event_received", { type: "session.closed", reason: "content" });
  callerLive!.emit("error", { type: "realtime_model_error", error: new Error("gone"), recoverable: false, timestamp: 0, label: "x" });
  callerLive!.emit("error", { type: "realtime_model_error", error: new Error("retrying"), recoverable: true, timestamp: 0, label: "x" });
  assert.deepEqual(ended, [{ reason: "provider content" }, { reason: "gone" }]);
  await caller.close();
  await consult.close();
});

test("a refused tool result is answered with a placeholder and the response resumed", () => {
  const live = new FakeLiveSession();
  armDelegationRecovery(live as unknown as openai.realtime.GPTLiveSession);
  live.emit("openai_client_event_queued", {
    type: "response.item.create",
    event_id: "tool_output_1",
    item: { type: "function_call_output", call_id: "call_big", output: "x".repeat(40_000) },
  });
  live.emit("openai_server_event_received", {
    type: "error",
    error: { code: "response_input_buffer_full", client_event_id: "tool_output_1" },
  });
  live.emit("openai_server_event_received", {
    type: "error",
    error: { code: "function_call_outputs_required", message: "Missing function call outputs for: call_big, call_other" },
  });
  const stubs = live.sent.filter((e) => e.type === "response.item.create");
  assert.deepEqual(stubs.map((e) => e.item.call_id), ["call_big", "call_other"], "each stranded call answered once");
  assert.ok(stubs.every((e) => JSON.parse(e.item.output).error === "result_too_large" && e.replayOnReconnect === false));
  assert.deepEqual(live.sent.at(-1)!.type, "response.create");
});

test("silence after a fault makes the voice model speak, once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const live = new FakeLiveSession();
  armDelegationRecovery(live as unknown as openai.realtime.GPTLiveSession);
  const fault = () =>
    live.emit("openai_server_event_received", { type: "error", error: { code: "response_input_buffer_full" } });
  fault();
  t.mock.timers.tick(3_999);
  assert.deepEqual(live.commentary, []);
  t.mock.timers.tick(1);
  assert.deepEqual(live.commentary, [[DELEGATION_STRANDED_COMMENTARY, undefined]]);
  fault();
  t.mock.timers.tick(10_000);
  assert.equal(live.commentary.length, 1, "one apology, not one per fault");
});

test("a backend that answers after a fault says nothing about it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const live = new FakeLiveSession();
  armDelegationRecovery(live as unknown as openai.realtime.GPTLiveSession);
  live.emit("openai_server_event_received", { type: "error", error: { code: "function_call_outputs_required", message: "call_a1" } });
  t.mock.timers.tick(2_000);
  live.emit("openai_server_event_received", { type: "response.event", event: { type: "response.created" } });
  t.mock.timers.tick(10_000);
  assert.deepEqual(live.commentary, []);
});

const settle = () => new Promise((r) => setImmediate(r));

test("a client delegation calls the delegate and speaks its answer on that delegation", async () => {
  const live = new FakeLiveSession();
  const history = [
    { role: "assistant" as const, text: "Acme Dental, Sam speaking." },
    { role: "user" as const, text: "Can I book for Tuesday?" },
  ];
  const tasks: string[] = [];
  attachClientDelegation(live as unknown as openai.realtime.GPTLiveSession, {
    delegateName: "Brain",
    history: () => history,
    invoke: async (task) => {
      tasks.push(task);
      return tasks.length === 1 ? { text: "Tuesday at ten is free." } : undefined;
    },
  });
  live.emit("delegation_created", { id: "del_1", pendingTranscript: "" });
  await settle();
  assert.match(tasks[0]!, /^Voice conversation so far:\nASSISTANT: Acme Dental, Sam speaking\.\nUSER: Can I book for Tuesday\?/);
  assert.deepEqual(live.commentary, [["Tuesday at ten is free.", { delegationId: "del_1" }]]);

  history.push({ role: "assistant", text: "Tuesday at ten is free." });
  live.emit("delegation_created", { id: "del_2", pendingTranscript: "Yes please, book it." });
  await settle();
  assert.equal(
    tasks[1],
    "Voice conversation since the previous delegation:\nASSISTANT: Tuesday at ten is free.\nUSER: Yes please, book it.\n\nAct on the user's most recent request in the conversation above.",
  );
  assert.deepEqual(live.commentary[1], [NO_ANSWER_COMMENTARY, { delegationId: "del_2" }]);
});

test("a failed client delegation is spoken as an apology", async () => {
  const live = new FakeLiveSession();
  attachClientDelegation(live as unknown as openai.realtime.GPTLiveSession, {
    delegateName: "Brain",
    history: () => [],
    invoke: async () => {
      throw new Error("504");
    },
  });
  live.emit("delegation_created", { id: "del_1", pendingTranscript: "Hello?" });
  await settle();
  assert.deepEqual(live.commentary, [[DELEGATION_FAILED_COMMENTARY, { delegationId: "del_1" }]]);
});

test("backend tokens are the delegate model's, with the prompt cache split out", () => {
  const vendors = resolveUsageVendors(voiceAgent(), GPT_LIVE, {
    llmBackend: { vendor: "openai", detail: "openai/gpt-5.6-terra" },
  });
  assert.deepEqual(vendors.llm, { vendor: "openai", detail: "openai/gpt-5.6-terra" });
  assert.deepEqual(resolveUsageVendors(voiceAgent(), GPT_LIVE).llm, { vendor: "openai", detail: "openai/gpt-live-1" });
  const rows: Record<string, number> = {};
  const meter = makeMetricsMeter((technology, _label, unit, quantity) => {
    if (quantity) rows[`${technology} ${unit}`] = (rows[`${technology} ${unit}`] ?? 0) + quantity;
  });
  meter({ type: "llm_metrics", label: "GPTLiveModel", promptTokens: 1000, promptCachedTokens: 200, cacheCreationTokens: 300, completionTokens: 50 });
  assert.deepEqual(rows, {
    "llm input_tokens": 500,
    "llm output_tokens": 50,
    "llm cache_read_tokens": 200,
    "llm cache_write_tokens": 300,
  });
});

test("GPT-Live is not OpenAI Realtime: no text output, no Realtime greeting path, its own inactivity wording", () => {
  const agent = voiceAgent({ tts: { vendor: "elevenlabs", voice: "x" } });
  assert.equal(textOutputEnabled(agent, GPT_LIVE), false);
  assert.equal(textOutputEnabled(agent, "livekit:openai/gpt-realtime"), true);
  assert.equal(isOpenAIRealtime("realtime", GPT_LIVE), false);
  assert.equal(isOpenAIRealtime("realtime", "livekit:openai/gpt-realtime"), true);
  const asked: unknown[] = [];
  const speaker = {
    say: () => assert.fail("no TTS on this session"),
    generateReply: (options: unknown) => {
      asked.push(options);
      return { waitForPlayout: async () => {} };
    },
  };
  speakInactivityMessage(speaker, "Still there?", { voiceMode: "realtime", textOutput: false, modelName: GPT_LIVE });
  assert.deepEqual(asked, [
    { instructions: "The caller has gone quiet. Say this to them now, then wait: Still there?", allowInterruptions: true },
  ]);
});
