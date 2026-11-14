import { test } from "node:test";
import assert from "node:assert/strict";
import { inference, initializeLogger, voice } from "@livekit/agents";

// Which route each pipeline stage takes (provider plugin or LiveKit Inference), at the five
// places that build one: pipeline STT, LLM and TTS, the side STT engines and the bridged STT.
// run: tsx --test test/pipeline-routing.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The plugins read their keys when first imported, so set them before loading the builders.
Object.assign(process.env, {
  DEEPGRAM_API_KEY: "test-deepgram",
  CARTESIA_API_KEY: "test-cartesia",
  ELEVEN_API_KEY: "test-eleven",
  OPENAI_API_KEY: "test-openai",
  GOOGLE_API_KEY: "test-google",
  LIVEKIT_API_KEY: "k",
  LIVEKIT_API_SECRET: "s",
  LIVEKIT_INFERENCE_URL: "http://127.0.0.1:9",
});
delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
delete process.env.LIVEKIT_PIPELINE_GOOGLE_TTS;
// A session warms up its LLM with a request. Nothing here may reach a provider.
globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as typeof fetch;

const cartesia = await import("@livekit/agents-plugin-cartesia");
const deepgram = await import("@livekit/agents-plugin-deepgram");
const elevenlabs = await import("@livekit/agents-plugin-elevenlabs");
const openai = await import("@livekit/agents-plugin-openai");
const { default: logger } = await import("../lib/logger.js");
const { pipelineSttRoute, pipelineLlmRoute, pipelineTtsRoute } = await import("../lib/pipeline-routing.js");
const { buildPipelineTts, createVoiceModelAndSession } = await import("../lib/voice-session-factory.js");
const { buildAuxStt, buildOutputStt, resolveAuxSttVendor } = await import("../lib/aux-stt.js");
const { buildBridgeStt } = await import("../lib/bridge-transcription.js");
const { resolveUsageVendors } = await import("../lib/usage-vendors.js");
const { makeUsageMeter } = await import("../lib/usage-meter.js");

const KEYS = "LIVEKIT_PIPELINE_USE_PROVIDER_KEYS";
const KEYS_OFF = { [KEYS]: undefined };
const KEYS_ON = { [KEYS]: "true" };

const OPENAI = "livekit:openai/gpt-4o-mini";
const VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
const CARTESIA_TTS = { vendor: "cartesia", voice: VOICE };

const makeAgent = (options: Record<string, unknown> = {}) =>
  ({ id: "agent-1", prompt: "You are a test agent.", options }) as any;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try {
    return fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
}

type Line = { level: string; fields: any; msg: string };

/** Run `fn` and return what it logged through the worker logger. */
function logged<T>(fn: () => T): { result: T; lines: Line[] } {
  const lines: Line[] = [];
  const levels = ["info", "warn", "error"] as const;
  const saved = levels.map((level) => (logger as any)[level]);
  levels.forEach((level) => {
    (logger as any)[level] = (fields: any, msg: string) => lines.push({ level, fields, msg });
  });
  try {
    return { result: fn(), lines };
  } finally {
    levels.forEach((level, i) => ((logger as any)[level] = saved[i]));
  }
}

const routesLine = (lines: Line[]) => lines.find((l) => l.msg.startsWith("pipeline routes:"));
const warnings = (lines: Line[]) => lines.filter((l) => l.level === "warn");

function pipelineSession(options: Record<string, unknown>, modelName = OPENAI) {
  return createVoiceModelAndSession({
    voiceMode: "pipeline",
    modelName,
    agent: makeAgent(options),
    call: { id: "call-1" } as any,
    tools: {} as any,
  }).session as any;
}

test("the route decision: direct needs provider keys on, a plugin and its key", () => {
  const assembly = makeAgent({ stt: { vendor: "assemblyai" }, tts: CARTESIA_TTS });
  const plain = makeAgent({ tts: CARTESIA_TTS });

  withEnv(KEYS_OFF, () => {
    assert.deepEqual(pipelineSttRoute(plain), { stage: "stt", vendor: "deepgram", route: "inference", fallback: false });
    assert.deepEqual(pipelineSttRoute(assembly), { stage: "stt", vendor: "assemblyai", route: "inference", fallback: false });
    assert.deepEqual(pipelineLlmRoute(OPENAI), { stage: "llm", vendor: "openai", route: "inference", fallback: false });
    assert.deepEqual(pipelineTtsRoute(plain), { stage: "tts", vendor: "cartesia", route: "inference", fallback: false });
  });

  withEnv(KEYS_ON, () => {
    assert.deepEqual(pipelineSttRoute(plain), { stage: "stt", vendor: "deepgram", route: "direct", fallback: false });
    assert.deepEqual(pipelineSttRoute(assembly), { stage: "stt", vendor: "assemblyai", route: "inference", fallback: true });
    assert.deepEqual(pipelineSttRoute(makeAgent({ stt: { vendor: "cartesia" } }), "aux-stt"), {
      stage: "aux-stt",
      vendor: "cartesia",
      route: "inference",
      fallback: true,
    });
    assert.equal(pipelineSttRoute(makeAgent({ stt: { vendor: "deepgram/nova-2:en" } })).route, "direct");

    assert.equal(pipelineLlmRoute(OPENAI).route, "direct");
    assert.equal(pipelineLlmRoute("livekit:google/gemini-2.5-flash").route, "direct");
    assert.deepEqual(pipelineLlmRoute("livekit:xai/grok-4.3"), { stage: "llm", vendor: "xai", route: "inference", fallback: true });

    assert.equal(pipelineTtsRoute(plain).route, "direct");
    assert.equal(pipelineTtsRoute(makeAgent({ tts: { vendor: "elevenlabs", voice: "abc" } })).route, "direct");
    assert.equal(pipelineTtsRoute(makeAgent({ tts: { vendor: "deepgram", voice: "aura-asteria-en" } })).route, "direct");
    assert.deepEqual(pipelineTtsRoute(makeAgent({ tts: { vendor: "rime/mistv3", voice: "luna" } })), {
      stage: "tts",
      vendor: "rime",
      route: "inference",
      fallback: true,
    });
  });
});

test("a missing key sends the stage to Inference and names the variable", () => {
  const plain = makeAgent({ tts: CARTESIA_TTS });
  const missing = (key: string, route: () => any) => withEnv({ ...KEYS_ON, [key]: undefined }, route);

  assert.deepEqual(missing("DEEPGRAM_API_KEY", () => pipelineSttRoute(plain)), {
    stage: "stt",
    vendor: "deepgram",
    route: "inference",
    fallback: true,
    missingKey: "DEEPGRAM_API_KEY",
  });
  assert.equal(missing("OPENAI_API_KEY", () => pipelineLlmRoute(OPENAI)).missingKey, "OPENAI_API_KEY");
  assert.equal(
    missing("GOOGLE_API_KEY", () => pipelineLlmRoute("livekit:google/gemini-2.5-flash")).missingKey,
    "GOOGLE_API_KEY",
  );
  assert.equal(missing("CARTESIA_API_KEY", () => pipelineTtsRoute(plain)).missingKey, "CARTESIA_API_KEY");
  assert.equal(
    missing("ELEVEN_API_KEY", () => pipelineTtsRoute(makeAgent({ tts: { vendor: "elevenlabs", voice: "abc" } }))).missingKey,
    "ELEVEN_API_KEY",
  );
  assert.equal(
    missing("DEEPGRAM_API_KEY", () => pipelineTtsRoute(makeAgent({ tts: { vendor: "deepgram", voice: "aura-asteria-en" } }))).missingKey,
    "DEEPGRAM_API_KEY",
  );

  // Vertex AI needs the project, not an API key.
  withEnv({ ...KEYS_ON, GOOGLE_API_KEY: undefined, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p" }, () => {
    assert.equal(pipelineLlmRoute("livekit:google/gemini-2.5-flash").route, "direct");
  });
  withEnv({ ...KEYS_ON, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: undefined }, () => {
    assert.equal(pipelineLlmRoute("livekit:google/gemini-2.5-flash").missingKey, "GOOGLE_CLOUD_PROJECT");
  });
});

test("Neuphonic and Google TTS are direct whatever the setting says", () => {
  for (const env of [KEYS_OFF, KEYS_ON]) {
    withEnv(env, () => {
      assert.deepEqual(pipelineTtsRoute(makeAgent({ tts: { vendor: "neuphonic", voice: "v" } })), {
        stage: "tts",
        vendor: "neuphonic",
        route: "direct",
        fallback: false,
      });
      assert.deepEqual(pipelineTtsRoute(makeAgent({ tts: { vendor: "google", voice: "Kore" } })), {
        stage: "tts",
        vendor: "google",
        route: "direct",
        fallback: false,
      });
    });
  }
});

test("pipeline session: plugin and key present gives the plugins, logged once", () => {
  const { result: session, lines } = withEnv(KEYS_ON, () => logged(() => pipelineSession({ tts: CARTESIA_TTS })));
  assert.ok(session.stt instanceof deepgram.STT);
  assert.ok(session.llm instanceof openai.LLM);
  assert.ok(session.tts instanceof cartesia.TTS);

  const routeLines = lines.filter((l) => l.msg.startsWith("pipeline routes:"));
  assert.equal(routeLines.length, 1);
  assert.equal(routeLines[0]!.level, "info");
  assert.equal(routeLines[0]!.msg, "pipeline routes: stt deepgram direct, llm openai direct, tts cartesia direct");
  assert.deepEqual(routeLines[0]!.fields, {
    agentId: "agent-1",
    routes: [
      { stage: "stt", vendor: "deepgram", route: "direct" },
      { stage: "llm", vendor: "openai", route: "direct" },
      { stage: "tts", vendor: "cartesia", route: "direct" },
    ],
  });
  assert.deepEqual(warnings(lines), []);
});

// Each of the next three was a hard failure at call setup under provider keys.

test("provider keys: an STT vendor other than Deepgram runs on Inference (was 'STT must be Deepgram')", () => {
  for (const [vendor, model] of [
    ["assemblyai", "assemblyai/universal-streaming"],
    ["cartesia", "cartesia/ink-whisper"],
  ]) {
    const { result: session, lines } = withEnv(KEYS_ON, () =>
      logged(() => pipelineSession({ stt: { vendor, language: "en-GB" }, tts: CARTESIA_TTS })),
    );
    assert.ok(session.stt instanceof inference.STT, vendor);
    assert.equal(session.stt.model, model);
    assert.equal((session.stt as any).opts.language, "en");
    // The other two stages stay on their plugins.
    assert.ok(session.llm instanceof openai.LLM);
    assert.ok(session.tts instanceof cartesia.TTS);
    assert.equal(routesLine(lines)!.msg, `pipeline routes: stt ${vendor} inference, llm openai direct, tts cartesia direct`);
    // No plugin is not a missing key: nothing to warn about.
    assert.deepEqual(warnings(lines), []);
  }
});

test("provider keys: an LLM plugin other than google or openai runs on Inference (was 'unsupported LLM plugin')", () => {
  const { result: session, lines } = withEnv(KEYS_ON, () =>
    logged(() => pipelineSession({ tts: CARTESIA_TTS }, "livekit:xai/grok-4.3")),
  );
  assert.ok(session.llm instanceof inference.LLM);
  // The configured name, with its vendor, as Inference ids are written.
  assert.equal(session.llm.model, "xai/grok-4.3");
  assert.ok(session.stt instanceof deepgram.STT);
  assert.ok(session.tts instanceof cartesia.TTS);
  assert.equal(routesLine(lines)!.msg, "pipeline routes: stt deepgram direct, llm xai inference, tts cartesia direct");
  assert.deepEqual(warnings(lines), []);
});

test("provider keys: a TTS with no direct builder runs on Inference (was 'not supported for direct API keys')", () => {
  const cases: Array<[Record<string, unknown>, string, string, string]> = [
    // A vendor the worker has no plugin for.
    [{ tts: { vendor: "rime/mistv3", voice: "luna" } }, "rime", "rime/mistv3", "luna"],
    // The direct builders match a plain vendor name, so a scoped one is not theirs.
    [{ tts: { vendor: "cartesia/sonic-3", voice: VOICE } }, "cartesia", "cartesia/sonic-3", VOICE],
    // No voice at all: the default pipeline TTS.
    [{}, "cartesia", "cartesia/sonic-3", VOICE],
  ];
  for (const [options, vendor, model, voice] of cases) {
    const { result: session, lines } = withEnv(KEYS_ON, () => logged(() => pipelineSession(options)));
    assert.ok(session.tts instanceof inference.TTS, model);
    assert.equal(session.tts.model, model);
    assert.equal((session.tts as any).opts.voice, voice);
    assert.ok(session.stt instanceof deepgram.STT);
    assert.ok(session.llm instanceof openai.LLM);
    assert.equal(routesLine(lines)!.msg, `pipeline routes: stt deepgram direct, llm openai direct, tts ${vendor} inference`);
    assert.deepEqual(warnings(lines), []);
  }
});

test("provider keys: a plugin without its key runs on Inference, with a warning (was a missing-key error)", () => {
  const env = { ...KEYS_ON, DEEPGRAM_API_KEY: undefined, OPENAI_API_KEY: undefined, CARTESIA_API_KEY: undefined };
  const { result: session, lines } = withEnv(env, () =>
    logged(() => pipelineSession({ tts: { ...CARTESIA_TTS, language: "fr-FR", speed: 1.2 } })),
  );
  assert.ok(session.stt instanceof inference.STT);
  assert.equal(session.stt.model, "deepgram/nova-3");
  assert.ok(session.llm instanceof inference.LLM);
  assert.equal(session.llm.model, "openai/gpt-4o-mini");
  // The Inference branch for Cartesia carries the language and the speed, as with provider keys off.
  assert.ok(session.tts instanceof inference.TTS);
  assert.equal(session.tts.model, "cartesia/sonic-3");
  assert.equal((session.tts as any).opts.voice, VOICE);
  assert.equal((session.tts as any).opts.language, "fr");
  assert.equal((session.tts as any).opts.modelOptions.speed, 1.2);

  assert.equal(routesLine(lines)!.msg, "pipeline routes: stt deepgram inference, llm openai inference, tts cartesia inference");
  assert.deepEqual(
    warnings(lines).map((l) => [l.fields.stage, l.fields.vendor, l.fields.missingKey]),
    [
      ["stt", "deepgram", "DEEPGRAM_API_KEY"],
      ["llm", "openai", "OPENAI_API_KEY"],
      ["tts", "cartesia", "CARTESIA_API_KEY"],
    ],
  );
  assert.equal(
    warnings(lines)[0]!.msg,
    "pipeline stt: DEEPGRAM_API_KEY is not set, so deepgram runs on LiveKit Inference and is billed to the LiveKit project",
  );
});

test("fallback TTS reuses the Inference branches: plain string models and Deepgram Aura-2", () => {
  withEnv({ ...KEYS_ON, CARTESIA_API_KEY: undefined, DEEPGRAM_API_KEY: undefined }, () => {
    const plain = buildPipelineTts(makeAgent({ tts: CARTESIA_TTS })) as any;
    assert.ok(plain instanceof inference.TTS);
    assert.equal(plain.model, "cartesia/sonic-3");
    assert.equal(plain.opts.voice, VOICE);

    const aura = buildPipelineTts(makeAgent({ tts: { vendor: "deepgram", voice: "aura-asteria-en", language: "en-GB" } })) as any;
    assert.ok(aura instanceof inference.TTS);
    assert.equal(aura.model, "deepgram/aura-2");
    assert.equal(aura.opts.voice, "asteria");
    assert.equal(aura.opts.language, "en-GB");
  });
});

test("provider keys: a model name with no vendor still fails, since there is nothing to route", () => {
  withEnv(KEYS_ON, () => {
    assert.throws(() => pipelineSession({ tts: CARTESIA_TTS }, "gpt-4o-mini"), {
      message: 'LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: expected modelName livekit:<plugin>/<model> (got "gpt-4o-mini")',
    });
  });
});

test("with provider keys off, every stage is on Inference as before", () => {
  // No key is read: the stages are on Inference with or without the provider keys.
  for (const keys of [{}, { DEEPGRAM_API_KEY: undefined, OPENAI_API_KEY: undefined, CARTESIA_API_KEY: undefined }]) {
    const { result: session, lines } = withEnv({ ...KEYS_OFF, ...keys }, () =>
      logged(() => pipelineSession({ stt: { vendor: "assemblyai" }, tts: CARTESIA_TTS })),
    );
    assert.ok(session.stt instanceof inference.STT);
    assert.equal(session.stt.model, "assemblyai/universal-streaming");
    assert.ok(session.llm instanceof inference.LLM);
    // The bare model id, as this path has always sent it.
    assert.equal(session.llm.model, "gpt-4o-mini");
    assert.ok(session.tts instanceof inference.TTS);
    assert.equal(session.tts.model, "cartesia/sonic-3");
    assert.equal(routesLine(lines)!.msg, "pipeline routes: stt assemblyai inference, llm openai inference, tts cartesia inference");
    assert.deepEqual(warnings(lines), []);
    // No error handler of ours on a stage that is not a fallback.
    assert.equal(session.stt.listenerCount("error"), 0);
  }
  withEnv(KEYS_OFF, () => {
    // TTS is still handed to the session as a model string.
    assert.equal(buildPipelineTts(makeAgent({ tts: CARTESIA_TTS })), `cartesia/sonic-3:${VOICE}`);
    assert.equal(pipelineSession({ tts: CARTESIA_TTS }, "weird-model").llm.model, "openai/gpt-4o-mini");
    assert.ok(buildAuxStt(makeAgent(), { vendor: "assemblyai" }) instanceof inference.STT);
    assert.ok(buildOutputStt(makeAgent(), {}) instanceof inference.STT);
    assert.ok(buildBridgeStt(makeAgent()) instanceof inference.STT);
  });
});

test("side and bridged STT engines follow the same rule and log their route", () => {
  withEnv(KEYS_ON, () => {
    const aux = logged(() => buildAuxStt(makeAgent({ stt: { language: "en-GB" } }), { vendor: "assemblyai" }));
    assert.ok(aux.result instanceof inference.STT);
    assert.equal((aux.result as any).model, "assemblyai/universal-streaming");
    assert.equal(routesLine(aux.lines)!.msg, "pipeline routes: aux-stt assemblyai inference");

    const output = logged(() => buildOutputStt(makeAgent(), { vendor: "cartesia" }));
    assert.ok(output.result instanceof inference.STT);
    assert.equal(routesLine(output.lines)!.msg, "pipeline routes: output-stt cartesia inference");

    const bridge = logged(() => buildBridgeStt(makeAgent({ stt: { vendor: "cartesia" } }), "fr"));
    assert.ok(bridge.result instanceof inference.STT);
    assert.equal((bridge.result as any).model, "cartesia/ink-whisper");
    assert.equal((bridge.result as any).opts.language, "fr");
    assert.equal(routesLine(bridge.lines)!.msg, "pipeline routes: bridge-stt cartesia inference");

    // Deepgram has a plugin and a key: direct, as before.
    assert.ok(buildAuxStt(makeAgent(), {}) instanceof deepgram.STT);
    assert.ok(buildOutputStt(makeAgent(), { vendor: "deepgram/nova-2" }) instanceof deepgram.STT);
    assert.ok(buildBridgeStt(makeAgent()) instanceof deepgram.STT);
  });

  withEnv({ ...KEYS_ON, DEEPGRAM_API_KEY: undefined }, () => {
    const { result, lines } = logged(() => buildBridgeStt(makeAgent()));
    assert.ok(result instanceof inference.STT);
    assert.deepEqual(
      warnings(lines).map((l) => [l.fields.stage, l.fields.missingKey]),
      [["bridge-stt", "DEEPGRAM_API_KEY"]],
    );
  });
});

test("ElevenLabs TTS is direct with its key", () => {
  withEnv(KEYS_ON, () => {
    assert.ok(buildPipelineTts(makeAgent({ tts: { vendor: "elevenlabs", voice: "abc" } })) instanceof elevenlabs.TTS);
  });
});

test("a fallback stage that fails says which stage, vendor and route", () => {
  const agent = makeAgent({ stt: { vendor: "assemblyai", language: "fr-FR" }, tts: CARTESIA_TTS });

  // Inference does not list this model for French. The configured name is passed as it is.
  const session = withEnv(KEYS_ON, () => pipelineSession(agent.options));
  assert.equal(session.stt.model, "assemblyai/universal-streaming");
  assert.equal((session.stt as any).opts.language, "fr");

  const { lines } = logged(() => {
    session.stt.emit("error", {
      type: "stt_error",
      timestamp: Date.now(),
      label: session.stt.label,
      error: new Error("model not available"),
      recoverable: false,
    });
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.level, "error");
  assert.equal(
    lines[0]!.msg,
    'pipeline stt: vendor "assemblyai" on LiveKit Inference (assemblyai/universal-streaming:fr) failed: model not available',
  );
  assert.deepEqual(lines[0]!.fields, {
    stage: "stt",
    vendor: "assemblyai",
    route: "inference",
    model: "assemblyai/universal-streaming:fr",
    recoverable: false,
  });

  // No LiveKit credentials: the build itself fails, with the same three facts.
  const noCredentials = {
    ...KEYS_ON,
    LIVEKIT_API_KEY: undefined,
    LIVEKIT_API_SECRET: undefined,
    LIVEKIT_INFERENCE_API_KEY: undefined,
    LIVEKIT_INFERENCE_API_SECRET: undefined,
  };
  withEnv(noCredentials, () => {
    assert.throws(() => pipelineSession(agent.options), {
      message:
        'pipeline stt: vendor "assemblyai" on LiveKit Inference (assemblyai/universal-streaming:fr) could not be built: apiKey is required: pass apiKey or set LIVEKIT_API_KEY',
    });
  });
});

test("usage vendors name the configured vendor, not the route", async () => {
  const agent = makeAgent({ stt: { vendor: "assemblyai", aux: { vendor: "cartesia" } }, tts: CARTESIA_TTS });
  const expected = {
    llm: { vendor: "openai", detail: "openai/gpt-4o-mini" },
    tts: { vendor: "cartesia", detail: "cartesia/sonic-3" },
    stt: { vendor: "assemblyai", detail: "assemblyai/universal-streaming" },
  };
  for (const env of [KEYS_OFF, KEYS_ON]) {
    withEnv(env, () => {
      assert.deepEqual(resolveUsageVendors(agent, OPENAI), expected);
      assert.deepEqual(resolveAuxSttVendor(agent, { vendor: "cartesia" }), { vendor: "cartesia", detail: "cartesia/ink-whisper" });
    });
  }

  // The stage itself reports the vendor-blind SDK label. The meter must not bill that.
  const session = withEnv(KEYS_ON, () => pipelineSession(agent.options));
  assert.equal(session.stt.label, "inference.STT");
  const usageVendors = withEnv(KEYS_ON, () => resolveUsageVendors(agent, OPENAI));

  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "o1", userId: "u1", agentId: "agent-1" }),
    usageVendors,
    saveUsageFn: async (records) => {
      saved.push(...(records as any[]));
    },
  });
  const handlers = new Map<string, (ev: any) => void>();
  meter.wire({ on: (evt: string, cb: (ev: any) => void) => handlers.set(evt, cb) } as any);
  handlers.get(voice.AgentSessionEventTypes.MetricsCollected)?.({
    metrics: { type: "stt_metrics", label: session.stt.label, audioDurationMs: 2000 },
  });
  handlers.get(voice.AgentSessionEventTypes.UserInputTranscribed)?.({ isFinal: true, transcript: "hello there" });
  await meter.flush(true);

  const sttRows = saved.filter((r) => r.technology === "stt");
  assert.ok(sttRows.length > 0);
  for (const row of sttRows) {
    assert.equal(row.provider, "assemblyai", row.unit);
    assert.notEqual(row.provider, "inference");
  }
});
