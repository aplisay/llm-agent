import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";

// What reaches a log line, and so the call's invocation log, for AgentSession error and close
// events, sessions, agents and instances; and the logger's own masking. Offline: the worker's
// real model and plugin classes, built with stand-in values in the environment.
// run: npx tsx --test test/log-fields.test.ts

const standIn = (name: string) => `${name}-standin-7f3a9c2e41b8d605`;
const ENV = {
  OPENAI_API_KEY: standIn("openai"),
  GOOGLE_API_KEY: standIn("google"),
  DEEPGRAM_API_KEY: standIn("deepgram"),
  CARTESIA_API_KEY: standIn("cartesia"),
  ELEVEN_API_KEY: standIn("elevenlabs"),
  ULTRAVOX_API_KEY: standIn("ultravox"),
  NEUPHONIC_API_KEY: standIn("neuphonic"),
  LIVEKIT_API_KEY: standIn("livekit-key"),
  LIVEKIT_API_SECRET: standIn("livekit-secret"),
};
const PUBLIC_OPTIONS_KEY = standIn("public-options");
const RECORD_VALUES = [
  standIn("tool"),
  standIn("tool-password"),
  standIn("recording"),
  standIn("instance"),
  standIn("call-hook"),
  standIn("instance-metadata"),
  standIn("call-metadata"),
];
const STAND_INS = [...Object.values(ENV), PUBLIC_OPTIONS_KEY, ...RECORD_VALUES];

// Set before the imports below: some plugins read the environment when their module loads.
Object.assign(process.env, ENV);

const { APIError, inference, initializeLogger, voice } = await import("@livekit/agents");
const openai = await import("@livekit/agents-plugin-openai");
const google = await import("@livekit/agents-plugin-google");
const deepgram = await import("@livekit/agents-plugin-deepgram");
const cartesia = await import("@livekit/agents-plugin-cartesia");
const elevenlabs = await import("@livekit/agents-plugin-elevenlabs");
const ultravox = await import("../plugins/ultravox/src/index.js");
const { OpenAIRealtimeModel } = await import("../lib/openai-realtime.js");
const { SentenceStreamTTS } = await import("../lib/sentence-stream-tts.js");
const { NeuphonicTTS } = await import("../lib/neuphonic-tts.js");
const { logOptions, setInvocationLogBuffer } = await import("../lib/logger.js");
const { agentForLog, instanceForLog, labelOf, scenarioForLog, sessionEventForLog, sessionModelsForLog } =
  await import("../lib/log-fields.js");

initializeLogger({ pretty: false, level: "fatal" });

const standInsIn = (text: string) => STAND_INS.filter((value) => text.includes(value));

/** JSON as a whole-object log line holds it: every enumerable field and toJSON(), cycles dropped. */
function serialised(x: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(x, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

type SessionEvent = Parameters<typeof sessionEventForLog>[0];

/** An error event as agents-js builds it: `source` is the model or plugin itself. */
const errorEvent = (source: object) =>
  ({
    type: "error",
    error: {
      type: "llm_error",
      timestamp: 1,
      label: "provider",
      error: new APIError("provider refused the request", { body: { code: "bad_request" }, retryable: true }),
      recoverable: true,
    },
    source,
    createdAt: 2,
  }) as unknown as SessionEvent;

/** Any model or plugin that keeps its options in a public field, as several SDK classes do. */
class PublicOptionsModel {
  _options = { model: "fake", apiKey: PUBLIC_OPTIONS_KEY };
  label() {
    return "fake.RealtimeModel";
  }
}

/** Every class the worker builds a session from, plus the plugin's own OpenAI Realtime model. */
const SOURCES: Record<string, () => object> = {
  OpenAIRealtimeModel: () => new OpenAIRealtimeModel({}),
  "openai.realtime.RealtimeModel": () => new openai.realtime.RealtimeModel({}),
  "google.beta.realtime.RealtimeModel": () => new google.beta.realtime.RealtimeModel({}),
  "ultravox.realtime.RealtimeModel": () => new ultravox.realtime.RealtimeModel({}),
  "inference.LLM": () => new inference.LLM({ model: "openai/gpt-4o-mini" }),
  "inference.STT": () => new inference.STT({ model: "deepgram/nova-3" }),
  "inference.TTS": () => new inference.TTS({ model: "cartesia/sonic-3", voice: "voice" }),
  "deepgram.STT": () => new deepgram.STT({ apiKey: ENV.DEEPGRAM_API_KEY }),
  "deepgram.TTS": () => new deepgram.TTS({ apiKey: ENV.DEEPGRAM_API_KEY }),
  "cartesia.TTS": () => new cartesia.TTS({}),
  "elevenlabs.TTS": () => new elevenlabs.TTS({ voiceId: "voice" }),
  "openai.LLM": () => new openai.LLM({}),
  "google.LLM": () => new google.LLM({ model: "gemini-2.5-flash" }),
  SentenceStreamTTS: () => new SentenceStreamTTS(new google.beta.TTS({})),
  NeuphonicTTS: () => new NeuphonicTTS({ apiKey: ENV.NEUPHONIC_API_KEY }),
  PublicOptionsModel: () => new PublicOptionsModel(),
};

test("an error event logs no value from its source's options", () => {
  assert.ok(serialised(errorEvent(new PublicOptionsModel())).includes(PUBLIC_OPTIONS_KEY), "logged whole");
  const found = Object.entries(SOURCES).flatMap(([name, make]) => {
    const values = standInsIn(serialised(sessionEventForLog(errorEvent(make()))));
    return values.length ? [`${name}: ${values.join(", ")}`] : [];
  });
  assert.deepEqual(found, []);
});

test("an error event logs its source by label, with the error's type, message and scalar fields", () => {
  for (const [name, make] of Object.entries(SOURCES)) {
    const source = make();
    const logged = sessionEventForLog(errorEvent(source));
    assert.equal(typeof logged.source, "string", name);
    assert.ok(logged.source, name);
    assert.equal(logged.source, labelOf(source), name);
    assert.deepEqual(
      logged,
      {
        type: "error",
        source: logged.source,
        error: {
          type: "llm_error",
          label: "provider",
          recoverable: true,
          error: { name: "APIError", message: "provider refused the request", retryable: true },
        },
        createdAt: 2,
      },
      name,
    );
  }
});

test("a close event logs its reason and error the same way", () => {
  const ev = {
    type: "close",
    error: {
      type: "realtime_model_error",
      timestamp: 1,
      label: "openai_realtime",
      error: new Error("OpenAI Realtime API connection closed"),
      recoverable: false,
    },
    reason: "error",
    createdAt: 2,
  } as unknown as SessionEvent;

  assert.deepEqual(sessionEventForLog(ev), {
    type: "close",
    reason: "error",
    error: {
      type: "realtime_model_error",
      label: "openai_realtime",
      recoverable: false,
      error: { name: "Error", message: "OpenAI Realtime API connection closed" },
    },
    createdAt: 2,
  });
});

test("a session logs its models by label", () => {
  const sessions: Record<string, ConstructorParameters<typeof voice.AgentSession>[0]> = {
    "OpenAI Realtime (plugin model)": { llm: new openai.realtime.RealtimeModel({}) },
    "Gemini Live": { llm: new google.beta.realtime.RealtimeModel({}) },
    Ultravox: { llm: new ultravox.realtime.RealtimeModel({}) },
    "LiveKit Inference pipeline": {
      stt: "deepgram/nova-3",
      llm: "openai/gpt-4o-mini",
      tts: "cartesia/sonic-3:voice",
    },
  };
  const found: string[] = [];
  for (const [name, options] of Object.entries(sessions)) {
    const logged = sessionModelsForLog(new voice.AgentSession(options));
    const values = standInsIn(serialised(logged));
    if (values.length) found.push(`${name}: ${values.join(", ")}`);
    assert.equal(typeof logged.llm, "string", name);
  }
  assert.deepEqual(found, []);
  const pipeline = sessionModelsForLog(new voice.AgentSession(sessions["LiveKit Inference pipeline"]));
  assert.equal(typeof pipeline.stt, "string");
  assert.equal(typeof pipeline.tts, "string");
});

const testAgent = () => ({
  id: "agent-1",
  prompt: "You are a helpful assistant.",
  options: {
    tts: { voice: "alloy" },
    recording: { enabled: true, key: standIn("recording") },
    callHook: { url: "https://hooks.example.test/call", hashKey: standIn("call-hook") },
  },
  keys: [
    { name: "crm", in: "bearer", value: standIn("tool") },
    { name: "legacy", in: "basic", username: "user", password: standIn("tool-password") },
  ],
});

const testInstance = (agent: ReturnType<typeof testAgent>) => ({
  id: "instance-1",
  key: standIn("instance"),
  recording: { enabled: true, key: standIn("recording") },
  metadata: { crm: { account: "acme", agent_key: standIn("instance-metadata") }, region: "eu" },
  Agent: agent,
});

test("an agent logs without its key values, recording key or call hook key", () => {
  const agent = testAgent();
  const logged = agentForLog(agent) as Record<string, any>;

  assert.deepEqual(standInsIn(serialised(logged)), []);
  assert.deepEqual(logged.keys, ["crm", "legacy"]);
  assert.equal(logged.prompt, agent.prompt);
  assert.deepEqual(logged.options, {
    tts: { voice: "alloy" },
    recording: { enabled: true },
    callHook: { url: "https://hooks.example.test/call" },
  });
  assert.equal(agent.keys[0]!.value, standIn("tool"), "the record itself is unchanged");
  assert.equal(agent.options.callHook.hashKey, standIn("call-hook"), "the record itself is unchanged");
});

test("an instance logs its agent by id and its metadata by field name", () => {
  const agent = testAgent();
  const logged = instanceForLog(testInstance(agent)) as Record<string, any>;

  assert.deepEqual(standInsIn(serialised(logged)), []);
  assert.equal(logged.id, "instance-1");
  assert.equal(logged.Agent, undefined);
  assert.equal(logged.agentId, "agent-1");
  assert.deepEqual(logged.recording, { enabled: true });
  assert.deepEqual(logged.metadata, { crm: ["account", "agent_key"], region: "string" });
  assert.equal(
    (instanceForLog({ ...testInstance(agent), agentId: "agent-2" }) as Record<string, any>).agentId,
    "agent-2",
    "an instance's own agentId wins",
  );
});

test("a scenario logs its agent and instance by id and its call metadata by field name", () => {
  const agent = testAgent();
  const scenario = {
    agent,
    instance: testInstance(agent),
    callerId: "+442079460810",
    callMetadata: { orderId: standIn("call-metadata") },
    sipHeaders: { "x-aplisay-trunk": "trunk-1" },
  };
  const logged = scenarioForLog(scenario) as Record<string, any>;

  assert.deepEqual(standInsIn(serialised(logged)), []);
  assert.deepEqual(logged, {
    agentId: "agent-1",
    instanceId: "instance-1",
    callerId: "+442079460810",
    callMetadata: ["orderId"],
    sipHeaders: { "x-aplisay-trunk": "trunk-1" },
  });
  assert.ok(!serialised(logged).includes(agent.prompt), "no copy of the agent definition");
});

test("the logger masks secret-named fields and the environment's secret values in any line", () => {
  const lines: Record<string, any>[] = [];
  setInvocationLogBuffer(lines);
  // The worker logger's options with a sink: the test runner reads this process's stdout.
  const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
  const logger = pino({ ...logOptions, level: "info" }, sink);

  // Whole SDK objects: an error event's source and a LiveKit Inference TTS.
  logger.error(
    { ev: { type: "error", source: new openai.realtime.RealtimeModel({}), createdAt: 1 } },
    "error",
  );
  logger.info({ tts: new inference.TTS({ model: "cartesia/sonic-3", voice: "voice" }) }, "tts");
  // An environment value inside another string, and secret-named fields holding other values.
  logger.warn({ url: `wss://example.test/ws?key=${ENV.GOOGLE_API_KEY}` }, "connect failed");
  logger.info(
    {
      request: { headers: { Authorization: "Bearer not-from-the-environment" } },
      room: { name: "room-1", _token: "eyJhbGciOiJIUzI1NiJ9.e30.signature", turnPassword: "" },
    },
    "fields",
  );

  // The buffer takes only lines that still parse.
  assert.equal(lines.length, 4);
  const text = JSON.stringify(lines);
  assert.deepEqual(standInsIn(text), []);
  assert.ok(!text.includes("not-from-the-environment"));
  assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.equal(lines[0]!.ev.type, "error");
  assert.equal(lines[2]!.url, "wss://example.test/ws?key=[Redacted]");
  assert.equal(lines[3]!.request.headers.Authorization, "[Redacted]");
  assert.deepEqual(lines[3]!.room, { name: "room-1", _token: "[Redacted]", turnPassword: "" });
});
