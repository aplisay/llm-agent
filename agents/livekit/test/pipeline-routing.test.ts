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
const FALLBACK = "LIVEKIT_PIPELINE_INFERENCE_FALLBACK";
const OFF = { [KEYS]: undefined, [FALLBACK]: undefined };
const KEYS_ONLY = { [KEYS]: "true", [FALLBACK]: undefined };
const MIXED = { [KEYS]: "true", [FALLBACK]: "true" };

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
const warnings = (lines: Line[]) =>
  lines.filter((l) => l.level === "warn" && (l.fields?.missingKey || l.fields?.pluginSkipped));

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

  withEnv(OFF, () => {
    assert.deepEqual(pipelineSttRoute(plain), { stage: "stt", vendor: "deepgram", route: "inference", fallback: false });
    assert.deepEqual(pipelineLlmRoute(OPENAI), { stage: "llm", vendor: "openai", route: "inference", fallback: false });
    assert.deepEqual(pipelineTtsRoute(plain), { stage: "tts", vendor: "cartesia", route: "inference", fallback: false });
  });

  // The setting does nothing on its own.
  withEnv({ [KEYS]: undefined, [FALLBACK]: "true" }, () => {
    assert.deepEqual(pipelineSttRoute(assembly), { stage: "stt", vendor: "assemblyai", route: "inference", fallback: false });
  });

  // Fallback off: every stage is sent to its direct builder, which reports what it cannot do.
  withEnv({ ...KEYS_ONLY, DEEPGRAM_API_KEY: undefined }, () => {
    assert.deepEqual(pipelineSttRoute(plain), { stage: "stt", vendor: "deepgram", route: "direct", fallback: false });
    assert.deepEqual(pipelineSttRoute(assembly), { stage: "stt", vendor: "assemblyai", route: "direct", fallback: false });
    assert.equal(pipelineLlmRoute("livekit:xai/grok-4.3").route, "direct");
  });

  withEnv(MIXED, () => {
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
  const missing = (key: string, route: () => any) => withEnv({ ...MIXED, [key]: undefined }, route);

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
  withEnv({ ...MIXED, GOOGLE_API_KEY: undefined, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p" }, () => {
    assert.equal(pipelineLlmRoute("livekit:google/gemini-2.5-flash").route, "direct");
  });
  withEnv({ ...MIXED, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: undefined }, () => {
    assert.equal(pipelineLlmRoute("livekit:google/gemini-2.5-flash").missingKey, "GOOGLE_CLOUD_PROJECT");
  });
});

test("Neuphonic and Google TTS are direct whatever the settings say", () => {
  for (const env of [OFF, KEYS_ONLY, MIXED]) {
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
  const { result: session, lines } = withEnv(MIXED, () => logged(() => pipelineSession({ tts: CARTESIA_TTS })));
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

test("pipeline session: a vendor with no plugin runs on Inference beside direct stages", () => {
  for (const [vendor, model] of [
    ["assemblyai", "assemblyai/universal-streaming"],
    ["cartesia", "cartesia/ink-whisper"],
  ]) {
    const { result: session, lines } = withEnv(MIXED, () =>
      logged(() => pipelineSession({ stt: { vendor, language: "en-GB" }, tts: CARTESIA_TTS })),
    );
    assert.ok(session.stt instanceof inference.STT, vendor);
    assert.equal(session.stt.model, model);
    assert.equal((session.stt as any).opts.language, "en");
    assert.ok(session.llm instanceof openai.LLM);
    assert.ok(session.tts instanceof cartesia.TTS);
    assert.equal(routesLine(lines)!.msg, `pipeline routes: stt ${vendor} inference, llm openai direct, tts cartesia direct`);
    // No plugin is not a missing key: nothing to warn about.
    assert.deepEqual(warnings(lines), []);
  }
});

test("pipeline session: an LLM or TTS vendor with no plugin runs on Inference under its configured name", () => {
  const { result: session, lines } = withEnv(MIXED, () =>
    logged(() => pipelineSession({ tts: { vendor: "rime/mistv3", voice: "luna" } }, "livekit:xai/grok-4.3")),
  );
  assert.ok(session.stt instanceof deepgram.STT);
  assert.ok(session.llm instanceof inference.LLM);
  assert.equal(session.llm.model, "xai/grok-4.3");
  assert.ok(session.tts instanceof inference.TTS);
  assert.equal(session.tts.model, "rime/mistv3");
  assert.equal((session.tts as any).opts.voice, "luna");
  assert.equal(routesLine(lines)!.msg, "pipeline routes: stt deepgram direct, llm xai inference, tts rime inference");
});

test("pipeline session: a plugin without its key runs on Inference, with a warning", () => {
  const env = { ...MIXED, DEEPGRAM_API_KEY: undefined, OPENAI_API_KEY: undefined, CARTESIA_API_KEY: undefined };
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
  assert.match(warnings(lines)[0]!.msg, /DEEPGRAM_API_KEY is not set, so deepgram runs on LiveKit Inference and is billed to the LiveKit project/);
});

test("a TTS the plugin builder does not take runs on Inference, with a warning", () => {
  // The direct builders match a plain vendor name. With the fallback off these two fail, as before.
  const scoped = makeAgent({ tts: { vendor: "cartesia/sonic-3", voice: VOICE } });
  const noVoice = makeAgent({});
  withEnv(KEYS_ONLY, () => {
    assert.throws(() => buildPipelineTts(scoped), /TTS vendor "cartesia\/sonic-3" is not supported for direct API keys/);
    assert.throws(() => buildPipelineTts(noVoice), /TTS vendor "unknown" is not supported for direct API keys/);
  });
  withEnv(MIXED, () => {
    for (const agent of [scoped, noVoice]) {
      assert.deepEqual(pipelineTtsRoute(agent), {
        stage: "tts",
        vendor: "cartesia",
        route: "inference",
        fallback: true,
        pluginSkipped: true,
      });
      const { result, lines } = logged(() => buildPipelineTts(agent)) as any;
      assert.ok(result instanceof inference.TTS);
      assert.equal(result.model, "cartesia/sonic-3");
      assert.equal(result.opts.voice, VOICE);
      assert.equal(warnings(lines).length, 1);
      assert.match(warnings(lines)[0].msg, /^pipeline tts: the cartesia plugin does not build this configuration .* billed to the LiveKit project$/);
    }
  });
});

test("fallback TTS reuses the Inference branches: plain string models and Deepgram Aura-2", () => {
  withEnv({ ...MIXED, CARTESIA_API_KEY: undefined, DEEPGRAM_API_KEY: undefined }, () => {
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

test("with the fallback off, provider keys fail as before", () => {
  const session = (options: Record<string, unknown>, modelName = OPENAI) => () => pipelineSession(options, modelName);
  withEnv(KEYS_ONLY, () => {
    assert.throws(session({ stt: { vendor: "assemblyai" }, tts: CARTESIA_TTS }), {
      message:
        'LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: STT must be Deepgram (got "assemblyai/universal-streaming:en"). Set options.stt.vendor to "deepgram" or "deepgram/<model>:<lang>"',
    });
    assert.throws(session({ stt: { vendor: "cartesia" }, tts: CARTESIA_TTS }), /STT must be Deepgram \(got "cartesia\/ink-whisper:en"\)/);
    assert.throws(session({ tts: CARTESIA_TTS }, "livekit:xai/grok-4.3"), {
      message:
        'LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: unsupported LLM plugin "xai" in livekit:xai/grok-4.3. Use livekit:google/... or livekit:openai/...',
    });
    assert.throws(session({ tts: { vendor: "rime/mistv3", voice: "luna" } }), {
      message:
        'LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: TTS vendor "rime/mistv3" is not supported for direct API keys. Use elevenlabs, cartesia, deepgram (aura-2), or google (Gemini TTS path).',
    });
    assert.throws(() => buildAuxStt(makeAgent(), { vendor: "assemblyai" }), /STT must be Deepgram/);
    assert.throws(() => buildOutputStt(makeAgent(), { vendor: "cartesia" }), /STT must be Deepgram/);
    assert.throws(() => buildBridgeStt(makeAgent({ stt: { vendor: "assemblyai" } })), /STT must be Deepgram/);
  });
  withEnv({ ...KEYS_ONLY, DEEPGRAM_API_KEY: undefined }, () => {
    assert.throws(session({ tts: CARTESIA_TTS }), {
      message:
        "LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: DEEPGRAM_API_KEY is missing or empty (set it in the environment or .env loaded before the agent runs).",
    });
    assert.throws(session({ tts: { vendor: "deepgram", voice: "aura-asteria-en" } }), /DEEPGRAM_API_KEY is missing or empty/);
  });
});

test("a model name with no vendor still fails under provider keys, fallback or not", () => {
  for (const env of [KEYS_ONLY, MIXED]) {
    withEnv(env, () => {
      assert.throws(() => pipelineSession({ tts: CARTESIA_TTS }, "gpt-4o-mini"), {
        message: 'LIVEKIT_PIPELINE_USE_PROVIDER_KEYS: expected modelName livekit:<plugin>/<model> (got "gpt-4o-mini")',
      });
    });
  }
});

test("with provider keys off, every stage is on Inference as before", () => {
  // The fallback setting changes nothing here.
  for (const fallback of [undefined, "true"]) {
    const { result: session, lines } = withEnv({ ...OFF, [FALLBACK]: fallback }, () =>
      logged(() => pipelineSession({ stt: { vendor: "assemblyai" }, tts: CARTESIA_TTS })),
    );
    assert.ok(session.stt instanceof inference.STT);
    assert.equal(session.stt.model, "assemblyai/universal-streaming");
    assert.ok(session.llm instanceof inference.LLM);
    assert.equal(session.llm.model, "gpt-4o-mini");
    assert.ok(session.tts instanceof inference.TTS);
    assert.equal(routesLine(lines)!.msg, "pipeline routes: stt assemblyai inference, llm openai inference, tts cartesia inference");
    assert.deepEqual(warnings(lines), []);
  }
  withEnv(OFF, () => {
    assert.equal(buildPipelineTts(makeAgent({ tts: CARTESIA_TTS })), `cartesia/sonic-3:${VOICE}`);
    assert.equal(pipelineSession({ tts: CARTESIA_TTS }, "weird-model").llm.model, "openai/gpt-4o-mini");
  });
});

test("side and bridged STT engines follow the same rule and log their route", () => {
  withEnv(MIXED, () => {
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

  withEnv({ ...MIXED, DEEPGRAM_API_KEY: undefined }, () => {
    const { result, lines } = logged(() => buildBridgeStt(makeAgent()));
    assert.ok(result instanceof inference.STT);
    assert.deepEqual(
      warnings(lines).map((l) => [l.fields.stage, l.fields.missingKey]),
      [["bridge-stt", "DEEPGRAM_API_KEY"]],
    );
  });

  withEnv(OFF, () => {
    assert.ok(buildAuxStt(makeAgent(), { vendor: "assemblyai" }) instanceof inference.STT);
    assert.ok(buildBridgeStt(makeAgent()) instanceof inference.STT);
  });
});

test("ElevenLabs TTS is direct with its key", () => {
  withEnv(MIXED, () => {
    assert.ok(buildPipelineTts(makeAgent({ tts: { vendor: "elevenlabs", voice: "abc" } })) instanceof elevenlabs.TTS);
  });
});

test("a fallback stage that fails says which stage, vendor and route", () => {
  const agent = makeAgent({ stt: { vendor: "assemblyai", language: "fr-FR" }, tts: CARTESIA_TTS });

  // Inference does not list this model for French. The configured name is passed as it is.
  const session = withEnv(MIXED, () => pipelineSession(agent.options));
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
    ...MIXED,
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

  // A stage that is on Inference because provider keys are off is left alone.
  const plain = withEnv(OFF, () => pipelineSession(agent.options));
  assert.equal(plain.stt.listenerCount("error"), 0);
});

test("usage vendors name the configured vendor, not the route", async () => {
  const agent = makeAgent({ stt: { vendor: "assemblyai", aux: { vendor: "cartesia" } }, tts: CARTESIA_TTS });
  const expected = {
    llm: { vendor: "openai", detail: "openai/gpt-4o-mini" },
    tts: { vendor: "cartesia", detail: "cartesia/sonic-3" },
    stt: { vendor: "assemblyai", detail: "assemblyai/universal-streaming" },
  };
  for (const env of [OFF, KEYS_ONLY, MIXED]) {
    withEnv(env, () => {
      assert.deepEqual(resolveUsageVendors(agent, OPENAI), expected);
      assert.deepEqual(resolveAuxSttVendor(agent, { vendor: "cartesia" }), { vendor: "cartesia", detail: "cartesia/ink-whisper" });
    });
  }

  // The stage itself reports the vendor-blind SDK label. The meter must not bill that.
  const session = withEnv(MIXED, () => pipelineSession(agent.options));
  assert.equal(session.stt.label, "inference.STT");
  const usageVendors = withEnv(MIXED, () => resolveUsageVendors(agent, OPENAI));

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
