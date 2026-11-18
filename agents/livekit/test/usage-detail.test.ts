import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger, voice } from "@livekit/agents";

// `detail` on stt, stt-aux, stt-output and tts usage rows names the model that runs on the route
// the stage takes, so a rate card can price the row by an exact line.
// run: npx tsx --test test/usage-detail.test.ts

initializeLogger({ pretty: false, level: "fatal" });

// The plugins read their keys when first imported, so set them before loading the builders.
Object.assign(process.env, {
  DEEPGRAM_API_KEY: "test-deepgram",
  CARTESIA_API_KEY: "test-cartesia",
  ELEVEN_API_KEY: "test-eleven",
  LIVEKIT_API_KEY: "k",
  LIVEKIT_API_SECRET: "s",
});
const KEYS = "LIVEKIT_PIPELINE_USE_PROVIDER_KEYS";
const LANG = "LIVEKIT_PIPELINE_STT_LANG";
const ELEVEN_MODEL = "LIVEKIT_PIPELINE_ELEVENLABS_MODEL";
const CARTESIA_MODEL = "LIVEKIT_PIPELINE_CARTESIA_TTS_MODEL";
for (const name of [KEYS, LANG, ELEVEN_MODEL, CARTESIA_MODEL, "LIVEKIT_PIPELINE_TTS", "LIVEKIT_PIPELINE_GOOGLE_TTS"]) {
  delete process.env[name];
}

const { resolveUsageVendors, sttUsageVendor, ttsUsageVendor } = await import("../lib/usage-vendors.js");
const { buildProviderPipelineStt, buildProviderPipelineTts, providerSttModel } = await import(
  "../lib/pipeline-provider-keys.js"
);
const { resolveAuxSttVendor, resolveOutputSttVendor } = await import("../lib/aux-stt.js");
const { makeUsageMeter } = await import("../lib/usage-meter.js");

const OFF = { [KEYS]: undefined };
const ON = { [KEYS]: "true" };
const VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";

const agent = (options: Record<string, unknown> = {}) => ({ id: "agent-1", prompt: "p", options }) as any;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try {
    return fn();
  } finally {
    Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  }
}

const sttDetail = (env: Record<string, string | undefined>, stt: Record<string, unknown> = {}) =>
  withEnv(env, () => sttUsageVendor(agent({ stt })));
const ttsDetail = (env: Record<string, string | undefined>, tts: Record<string, unknown>) =>
  withEnv(env, () => ttsUsageVendor(agent({ tts })));

// --- Deepgram multilingual ---------------------------------------------------------------

test("on Inference, Deepgram with language multi is marked apart from one language", () => {
  assert.deepEqual(sttDetail(OFF), { vendor: "deepgram", detail: "deepgram/nova-3" });
  assert.deepEqual(sttDetail(OFF, { language: "fr-FR" }), { vendor: "deepgram", detail: "deepgram/nova-3" });
  assert.equal(sttDetail(OFF, { vendor: "deepgram/nova-3:multi" }).detail, "deepgram/nova-3-multilingual");
  assert.equal(sttDetail(OFF, { vendor: "deepgram/nova-2:Multi" }).detail, "deepgram/nova-2-multilingual");
  assert.equal(sttDetail(OFF, { vendor: "deepgram/nova-2:en" }).detail, "deepgram/nova-2");
  // The variable is the language a plain vendor gets when the agent names none.
  assert.equal(sttDetail({ ...OFF, [LANG]: "multi" }).detail, "deepgram/nova-3-multilingual");
  assert.equal(sttDetail({ ...OFF, [LANG]: "multi" }, { language: "de-DE" }).detail, "deepgram/nova-3");
});

test("the marker is for Deepgram only", () => {
  assert.deepEqual(sttDetail(OFF, { vendor: "assemblyai/universal-streaming:multi" }), {
    vendor: "assemblyai",
    detail: "assemblyai/universal-streaming",
  });
  assert.equal(sttDetail({ ...OFF, [LANG]: "multi" }, { vendor: "cartesia" }).detail, "cartesia/ink-whisper");
});

test("on the Deepgram plugin the row follows the language the plugin is given", () => {
  // The plugin takes its language from options.stt.language, not from a `:lang` suffix.
  const scoped = agent({ stt: { vendor: "deepgram/nova-3:multi" } });
  withEnv(ON, () => {
    assert.equal(sttUsageVendor(scoped).detail, "deepgram/nova-3");
    assert.deepEqual(providerSttModel(scoped), { model: "nova-3", language: "en-US" });
  });
  assert.equal(sttDetail(ON, { vendor: "deepgram/nova-2-phonecall" }).detail, "deepgram/nova-2-phonecall");
  assert.equal(sttDetail({ ...ON, [LANG]: "multi" }, { language: "multi" }).detail, "deepgram/nova-3-multilingual");
  assert.equal(sttDetail({ ...ON, [LANG]: "multi" }).detail, "deepgram/nova-3");
  // No key: the stage runs on Inference, so the Inference rule applies.
  assert.equal(
    sttDetail({ ...ON, DEEPGRAM_API_KEY: undefined }, { vendor: "deepgram/nova-3:multi" }).detail,
    "deepgram/nova-3-multilingual",
  );
});

test("the plugin STT row names the model the plugin is built with", () => {
  for (const stt of [{}, { vendor: "deepgram/nova-2:en" }, { vendor: "deepgram/nova-3-medical" }]) {
    withEnv(ON, () => {
      const built = buildProviderPipelineStt(agent({ stt })) as any;
      assert.equal(sttUsageVendor(agent({ stt })).detail, `deepgram/${built.model}`);
    });
  }
});

test("side engines follow the same rule", () => {
  const base = agent({ stt: { language: "en-GB" } });
  withEnv(OFF, () => {
    assert.deepEqual(resolveAuxSttVendor(base, {}), { vendor: "deepgram", detail: "deepgram/nova-3" });
    assert.equal(resolveAuxSttVendor(base, { vendor: "deepgram/nova-3:multi" }).detail, "deepgram/nova-3-multilingual");
    assert.equal(resolveOutputSttVendor(base, { vendor: "deepgram/nova-2:multi" }).detail, "deepgram/nova-2-multilingual");
    assert.equal(resolveAuxSttVendor(base, { vendor: "assemblyai" }).detail, "assemblyai/universal-streaming");
  });
  withEnv(ON, () => {
    assert.equal(resolveAuxSttVendor(base, { vendor: "deepgram/nova-3:multi" }).detail, "deepgram/nova-3");
    assert.equal(resolveOutputSttVendor(base, { vendor: "deepgram/nova-2" }).detail, "deepgram/nova-2");
  });
});

// --- TTS on the worker's own keys ---------------------------------------------------------

test("on Inference the TTS row names the Inference model, whatever the plugin variables say", () => {
  const env = { ...OFF, [ELEVEN_MODEL]: "eleven_flash_v2_5", [CARTESIA_MODEL]: "sonic-turbo" };
  assert.deepEqual(ttsDetail(env, { vendor: "elevenlabs", voice: "abc" }), {
    vendor: "elevenlabs",
    detail: "elevenlabs/eleven_turbo_v2_5",
  });
  assert.equal(ttsDetail(env, { vendor: "cartesia", voice: VOICE }).detail, "cartesia/sonic-3");
  assert.equal(ttsDetail(env, { vendor: "deepgram", voice: "aura-asteria-en" }).detail, "deepgram/aura-2");
  assert.equal(ttsDetail(env, { vendor: "cartesia/sonic-2", voice: VOICE }).detail, "cartesia/sonic-2");
});

const DIRECT_TTS: [Record<string, string>, Record<string, unknown>, string][] = [
  [{}, { vendor: "elevenlabs", voice: "abc" }, "elevenlabs/eleven_turbo_v2_5"],
  [{ [ELEVEN_MODEL]: "eleven_flash_v2_5" }, { vendor: "elevenlabs", voice: "abc" }, "elevenlabs/eleven_flash_v2_5"],
  [{}, { vendor: "cartesia", voice: VOICE }, "cartesia/sonic-3"],
  [{ [CARTESIA_MODEL]: "sonic-turbo" }, { vendor: "cartesia", voice: VOICE }, "cartesia/sonic-turbo"],
  [{}, { voice: VOICE }, "cartesia/sonic-3"],
];

test("on a plugin the TTS row names the model the plugin is built with", () => {
  for (const [vars, tts, detail] of DIRECT_TTS) {
    withEnv({ ...ON, ...vars }, () => {
      const built = buildProviderPipelineTts(agent({ tts })) as any;
      const row = ttsUsageVendor(agent({ tts }));
      assert.equal(row.detail, detail, JSON.stringify(tts));
      assert.equal(row.detail, `${row.vendor}/${built.model}`);
    });
  }
});

test("the Deepgram plugin row names an Aura-1 voice as its own model, and keeps deepgram/aura-2 for Aura-2", () => {
  const cases: [string, string, string][] = [
    // voice, the model the plugin is given, the row
    ["aura-asteria-en", "aura-asteria-en", "deepgram/aura-asteria-en"],
    ["asteria", "aura-asteria-en", "deepgram/aura-asteria-en"],
    ["aura-helios-en", "aura-helios-en", "deepgram/aura-helios-en"],
    ["aura-2-thalia-en", "aura-2-thalia-en", "deepgram/aura-2"],
  ];
  for (const [voiceId, model, detail] of cases) {
    const tts = { vendor: "deepgram", voice: voiceId };
    withEnv(ON, () => {
      assert.equal((buildProviderPipelineTts(agent({ tts })) as any).model, model);
      assert.deepEqual(ttsUsageVendor(agent({ tts })), { vendor: "deepgram", detail });
    });
  }
});

test("a vendor whose key is not set runs on Inference and its row says so", () => {
  const env = { ...ON, ELEVEN_API_KEY: undefined, [ELEVEN_MODEL]: "eleven_flash_v2_5" };
  assert.equal(ttsDetail(env, { vendor: "elevenlabs", voice: "abc" }).detail, "elevenlabs/eleven_turbo_v2_5");
  assert.equal(
    ttsDetail({ ...ON, DEEPGRAM_API_KEY: undefined }, { vendor: "deepgram", voice: "aura-asteria-en" }).detail,
    "deepgram/aura-2",
  );
});

test("Neuphonic rows are unchanged", () => {
  for (const env of [OFF, ON]) {
    assert.deepEqual(ttsDetail(env, { vendor: "neuphonic", voice: "some-voice" }), { vendor: "neuphonic", detail: "neuphonic" });
    assert.deepEqual(ttsDetail(env, { vendor: "neuphonic" }), { vendor: "neuphonic", detail: "neuphonic" });
  }
});

// --- one row per unit for a call ----------------------------------------------------------

test("a session's stt and tts meters land on one detail each", async () => {
  const a = agent({ stt: { vendor: "deepgram/nova-3:multi" }, tts: { vendor: "deepgram", voice: "aura-asteria-en" } });
  const usageVendors = withEnv(ON, () => resolveUsageVendors(a, "livekit:openai/gpt-4o-mini"));
  const saved: any[] = [];
  const meter = makeUsageMeter({
    getCall: () => ({ id: "call-1", organisationId: "o1", userId: "u1", agentId: "agent-1" }),
    usageVendors,
    saveUsageFn: async (records) => void saved.push(...(records as any[])),
  });
  const handlers = new Map<string, (ev: any) => void>();
  meter.wire({ on: (evt: string, cb: (ev: any) => void) => handlers.set(evt, cb) } as any);
  const metrics = handlers.get(voice.AgentSessionEventTypes.MetricsCollected)!;
  for (let i = 0; i < 2; i++) {
    metrics({ metrics: { type: "stt_metrics", label: "deepgram.STT", audioDurationMs: 2000 } });
    metrics({ metrics: { type: "tts_metrics", label: "deepgram.TTS", charactersCount: 10, audioDurationMs: 700 } });
    handlers.get(voice.AgentSessionEventTypes.UserInputTranscribed)!({ isFinal: true, transcript: "hello" });
  }
  await meter.flush(true);
  assert.deepEqual(
    saved.map((r) => [r.technology, r.provider, r.detail, r.unit, r.quantity]).sort(),
    [
      ["stt", "deepgram", "deepgram/nova-3", "characters", 10],
      ["stt", "deepgram", "deepgram/nova-3", "milliseconds", 4000],
      ["tts", "deepgram", "deepgram/aura-asteria-en", "characters", 20],
      ["tts", "deepgram", "deepgram/aura-asteria-en", "milliseconds", 1400],
    ],
  );
});
