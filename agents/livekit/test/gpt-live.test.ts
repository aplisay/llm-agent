import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeLogger, llm } from "@livekit/agents";
import {
  BACKEND_TOOL_POLICY,
  DELEGATION_FAILED_COMMENTARY,
  DELEGATION_STRANDED_COMMENTARY,
  GPT_LIVE_DEFAULT_VOICE,
  NO_ANSWER_COMMENTARY,
  OPENING_INSTRUCTION,
  SYNTHETIC_BACKEND_MODEL_NAME,
  VOICE_DELEGATION_POLICY,
  backendSettings,
  chunkText,
  composeBackendInstructions,
  composeVoiceInstructions,
  deepMerge,
  delegateBackend,
  delegationMode,
  droppedOutputStub,
  estimatedTokens,
  findDelegateFunction,
  greetingOpeningInstruction,
  inactivityCommentary,
  isGptLiveModelId,
  isGptLiveModelName,
  languageLine,
  liveOverrides,
  mergeTools,
  missingCallIds,
  prepareGptLive,
  renderTranscriptRequest,
  resolveDelegate,
  resolveDelegateTarget,
  subagentAnswerText,
} from "../lib/gpt-live.js";
import { createTools } from "../lib/agent-tools.js";

// GPT-Live's SDK-free half: agents/pipecat/tests/test_gpt_live.py covers the Pipecat twin.
// run: npx tsx --test test/gpt-live.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const DELEGATE_ID = "11111111-2222-3333-4444-555555555555";

const delegateFn = (agentParam: Record<string, unknown>) => ({
  name: "brain",
  description: "Handles lookups",
  implementation: "builtin",
  platform: "delegate",
  input_schema: { properties: { agent: agentParam } },
});

const voiceAgent = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "voice-1",
    name: "Sam",
    organisationId: "org-1",
    modelName: "livekit:openai/gpt-live-1",
    prompt: "You are Sam, the receptionist.",
    functions: [],
    keys: [],
    options: {},
    ...overrides,
  }) as any;

const textAgent = (modelName: string, overrides: Record<string, unknown> = {}) =>
  ({
    id: DELEGATE_ID,
    name: "Brain",
    type: "text",
    organisationId: "org-1",
    modelName,
    prompt: "You book appointments.",
    functions: [],
    keys: [],
    options: {},
    ...overrides,
  }) as any;

/** Records warnings instead of logging them. */
const recorder = () => {
  const warnings: string[] = [];
  return { warnings, log: { warn: (_: object, msg: string) => void warnings.push(msg) } };
};

const pipecatSource = (file: string) =>
  readFileSync(new URL(`../../pipecat/pipecat_aplisay/${file}`, import.meta.url), "utf8");

function pythonConstant(source: string, name: string): string {
  const triple = source.match(new RegExp(`^${name} = """([\\s\\S]*?)"""`, "m"));
  if (triple) return triple[1]!;
  const single = source.match(new RegExp(`^${name} = "([^"\\\\]*)"$`, "m"));
  if (single) return single[1]!;
  const parts = source.match(new RegExp(`^${name} = \\(\\n([\\s\\S]*?)\\n\\)`, "m"));
  assert.ok(parts, `${name} not found`);
  return [...parts[1]!.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join("");
}

test("the texts sent to the model are byte-identical to the Pipecat worker's", () => {
  const gptLive = pipecatSource("gpt_live.py");
  const service = pipecatSource("gpt_live_service.py");
  assert.equal(VOICE_DELEGATION_POLICY, pythonConstant(gptLive, "VOICE_DELEGATION_POLICY"));
  assert.equal(BACKEND_TOOL_POLICY, pythonConstant(gptLive, "BACKEND_TOOL_POLICY"));
  assert.equal(OPENING_INSTRUCTION, pythonConstant(gptLive, "OPENING_INSTRUCTION"));
  assert.equal(SYNTHETIC_BACKEND_MODEL_NAME, pythonConstant(gptLive, "SYNTHETIC_BACKEND_MODEL_NAME"));
  assert.equal(GPT_LIVE_DEFAULT_VOICE, pythonConstant(gptLive, "GPT_LIVE_DEFAULT_VOICE"));
  assert.equal(DELEGATION_FAILED_COMMENTARY, pythonConstant(service, "DELEGATION_FAILED_COMMENTARY"));
  assert.equal(DELEGATION_STRANDED_COMMENTARY, pythonConstant(service, "DELEGATION_STRANDED_COMMENTARY"));
  assert.ok(service.includes(JSON.stringify(NO_ANSWER_COMMENTARY)));
  // The f-strings, with their placeholders.
  assert.ok(gptLive.includes(`"${greetingOpeningInstruction(voiceAgent({ options: { greeting: { text: "{text}" } } }))}"`));
  assert.ok(gptLive.includes(`"The caller has gone quiet. Say this to them now, then wait: {message}"`));
  const stubMessage = gptLive.match(/"message": \(\n([\s\S]*?)\n\s*\),/);
  assert.ok(stubMessage, "dropped_output_stub message not found");
  assert.equal(
    (JSON.parse(droppedOutputStub("call_x")) as { message: string }).message,
    [...stubMessage[1]!.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).join(""),
  );
});

test("model ids: only the GPT-Live rows, on the livekit handler", () => {
  assert.equal(isGptLiveModelId("openai/gpt-live-1"), true);
  assert.equal(isGptLiveModelId("OpenAI/GPT-Live-2"), true);
  assert.equal(isGptLiveModelId("openai/gpt-realtime"), false);
  assert.equal(isGptLiveModelName("livekit:openai/gpt-live-1"), true);
  assert.equal(isGptLiveModelName("livekit:openai/gpt-realtime"), false);
  assert.equal(isGptLiveModelName("pipecat:openai/gpt-live-1"), false);
  assert.equal(isGptLiveModelName(undefined), false);
});

test("the delegate's model picks the mode", () => {
  assert.equal(delegationMode("text:openai/gpt-5.6-terra"), "responses");
  assert.equal(delegationMode("text:anthropic/claude-sonnet-5"), "client");
  assert.equal(delegationMode("text:openrouter/openai/gpt-5"), "client");
  assert.deepEqual(delegateBackend({ agent: textAgent("text:openai/gpt-5.6-terra"), synthetic: false, mode: "responses" }), {
    modelId: "openai/gpt-5.6-terra",
    vendor: "openai",
    model: "gpt-5.6-terra",
  });
});

test("the delegate target: a static id or a metadata path, never a generated one", () => {
  const metadata = { aplisay: { brain: ` ${DELEGATE_ID} ` } };
  assert.equal(resolveDelegateTarget(delegateFn({ source: "static", from: DELEGATE_ID }) as any, {}), DELEGATE_ID);
  assert.equal(resolveDelegateTarget(delegateFn({ source: "metadata", from: "aplisay.brain" }) as any, metadata), DELEGATE_ID);
  assert.equal(resolveDelegateTarget(delegateFn({ source: "metadata", from: "aplisay.missing" }) as any, metadata), undefined);
  assert.equal(resolveDelegateTarget(delegateFn({ source: "generated" }) as any, metadata), undefined);
  assert.equal(findDelegateFunction(voiceAgent()), undefined);
});

test("a declared delegate is fetched with the organisation", async () => {
  const fetched: [string, string | undefined][] = [];
  const agent = voiceAgent({ functions: [delegateFn({ source: "static", from: DELEGATE_ID })] });
  const { log, warnings } = recorder();
  const spec = await resolveDelegate(agent, {}, "org-1", {
    fetchAgent: async (id, org) => {
      fetched.push([id, org]);
      return textAgent("text:openai/gpt-5.6-terra");
    },
    log,
  });
  assert.deepEqual(fetched, [[DELEGATE_ID, "org-1"]]);
  assert.equal(spec.synthetic, false);
  assert.equal(spec.mode, "responses");
  assert.equal(spec.agent.id, DELEGATE_ID);
  assert.deepEqual(warnings, []);
});

test("no delegate means the synthetic backend on the voice agent's own prompt", async () => {
  const agent = voiceAgent({ options: { effort: "low" } });
  const spec = await resolveDelegate(agent, {}, "org-1", {
    fetchAgent: async () => assert.fail("nothing to fetch"),
    log: recorder().log,
  });
  assert.equal(spec.synthetic, true);
  assert.equal(spec.mode, "responses");
  assert.equal(spec.agent.modelName, SYNTHETIC_BACKEND_MODEL_NAME);
  assert.equal(spec.agent.prompt, agent.prompt);
  assert.deepEqual(spec.agent.functions, []);
  assert.deepEqual(backendSettings(spec.agent), { effort: "low" });
});

test("a bad delegate falls back to the synthetic backend with a warning, never failing the call", async () => {
  const agent = voiceAgent({ functions: [delegateFn({ source: "static", from: DELEGATE_ID })] });
  for (const fetchAgent of [
    async () => {
      throw new Error("404");
    },
    async () => textAgent("text:openai/gpt-5.6-terra", { type: "interactive-audio" }),
  ]) {
    const { log, warnings } = recorder();
    const spec = await resolveDelegate(agent, {}, "org-1", { fetchAgent, log });
    assert.equal(spec.synthetic, true);
    assert.equal(warnings.length, 1);
  }
  const { log, warnings } = recorder();
  const unresolved = voiceAgent({ functions: [delegateFn({ source: "metadata", from: "aplisay.brain" })] });
  assert.equal((await resolveDelegate(unresolved, {}, "org-1", { fetchAgent: async () => assert.fail(), log })).synthetic, true);
  assert.match(warnings[0]!, /names no agent/);
});

test("a non-OpenAI delegate runs as client delegation, with no tools on the voice session", async () => {
  const agent = voiceAgent({ functions: [delegateFn({ source: "static", from: DELEGATE_ID })] });
  const prepared = await prepareGptLive({
    agent,
    metadata: {},
    organisationId: "org-1",
    buildTools: () => assert.fail("client mode builds no tools"),
    fetchAgent: async () => textAgent("text:anthropic/claude-sonnet-5"),
    log: recorder().log,
  });
  assert.equal(prepared.spec.mode, "client");
  assert.equal(prepared.tools.flatten().length, 0);
});

test("prompt composition appends the platform blocks", () => {
  const agent = voiceAgent({ options: { tts: { language: "en-GB" } } });
  assert.equal(
    composeVoiceInstructions(agent.prompt, { language: languageLine(agent) }),
    `You are Sam, the receptionist.\n\nSpeak en-GB unless the caller asks you to switch language.\n\n${VOICE_DELEGATION_POLICY}`,
  );
  assert.equal(languageLine(voiceAgent({ options: { stt: { language: "multi" } } })), undefined);
  assert.equal(
    composeBackendInstructions("", { toolNames: ["hangup", "get_slots"] }),
    `You are a helpful assistant.\n\n${BACKEND_TOOL_POLICY}\n\nTools available to you: get_slots, hangup.`,
  );
  assert.equal(composeVoiceInstructions(""), `You are a helpful voice assistant.\n\n${VOICE_DELEGATION_POLICY}`);
});

const toolOf = (description: string) =>
  llm.tool({ description, parameters: { type: "object", properties: {} }, execute: async () => description });

test("merged tools: the delegate's definition wins a clash, and the clash is logged", () => {
  const voiceTools = new llm.ToolContext({ hangup: toolOf("voice hangup"), lookup: toolOf("voice lookup") });
  const delegateTools = new llm.ToolContext({ lookup: toolOf("delegate lookup"), book: toolOf("delegate book") });
  const { log, warnings } = recorder();
  const merged = mergeTools(voiceTools, delegateTools, log);
  assert.deepEqual(Object.keys(merged.functionTools).sort(), ["book", "hangup", "lookup"]);
  assert.equal(merged.functionTools.lookup!.description, "delegate lookup");
  assert.match(warnings[0]!, /lookup/);
  assert.equal(mergeTools(voiceTools, undefined, log), voiceTools);
});

test("the delegate declaration is never a tool", () => {
  const tools = createTools({
    agent: voiceAgent({
      functions: [
        delegateFn({ source: "static", from: DELEGATE_ID }),
        { name: "hangup", description: "End the call", implementation: "builtin", platform: "hangup", input_schema: { properties: {} } },
      ],
    }),
    call: { id: "call-1" } as any,
    room: {} as any,
    participant: null,
    sendMessage: async () => {},
    metadata: {} as any,
    onHangup: async () => ({ status: "OK" }) as any,
    onTransfer: async () => assert.fail("not used"),
    getTransferState: () => ({ state: "none", description: "" }),
  });
  assert.deepEqual(Object.keys(tools.functionTools), ["hangup"]);
});

test("backend settings and the vendorSpecific escape hatch", () => {
  assert.deepEqual(backendSettings(textAgent("x", { options: { effort: " High ", maxTokens: 400, temperature: 0.3 } })), {
    effort: "high",
    maxTokens: 400,
  });
  assert.deepEqual(backendSettings(textAgent("x", { options: { maxTokens: 0 } })), {});
  assert.deepEqual(backendSettings(textAgent("x", { options: { maxTokens: 2.5 } })), {});
  const agent = voiceAgent({ options: { vendorSpecific: { openai: { live: { store: false, delegation: { responses: { model: "gpt-5.6-sol" } } } } } } });
  assert.deepEqual(liveOverrides(agent), { store: false, delegation: { responses: { model: "gpt-5.6-sol" } } });
  assert.deepEqual(liveOverrides(voiceAgent()), {});
  assert.deepEqual(
    deepMerge({ audio: { output: { voice: "marin" } }, delegation: { type: "responses", responses: { model: "a", tools: [1] } } }, liveOverrides(agent)),
    { audio: { output: { voice: "marin" } }, delegation: { type: "responses", responses: { model: "gpt-5.6-sol", tools: [1] } }, store: false },
  );
});

test("the opening: the greeting text, the greeting instructions, or the platform default", () => {
  assert.equal(
    greetingOpeningInstruction(voiceAgent({ options: { greeting: { text: " Acme Dental, Sam speaking. " } } })),
    "Immediately say the following exactly and in full, then listen: Acme Dental, Sam speaking.",
  );
  assert.equal(
    greetingOpeningInstruction(voiceAgent({ options: { greeting: { instructions: "Welcome them warmly." } } })),
    "Immediately open the conversation. For your opening line only, follow these instructions, then listen: Welcome them warmly.",
  );
  assert.equal(greetingOpeningInstruction(voiceAgent()), OPENING_INSTRUCTION);
  assert.equal(inactivityCommentary("Still there?"), "The caller has gone quiet. Say this to them now, then wait: Still there?");
});

test("long appends are chunked on sentences, under the token budget", () => {
  assert.deepEqual(chunkText("  Short.  "), ["Short."]);
  assert.deepEqual(chunkText(""), []);
  const sentence = "The next available appointment is on Tuesday at ten in the morning with Doctor Patel. ";
  const text = sentence.repeat(40);
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(estimatedTokens(chunk) <= 100, chunk);
    assert.ok(chunk.endsWith("."), "breaks fall on sentence boundaries");
  }
  assert.equal(chunks.join(" "), text.trim());
  // A sentence longer than the budget splits at a space; non-ASCII counts a token per character.
  const words = chunkText("word ".repeat(200).trim(), 20);
  assert.ok(words.every((c) => estimatedTokens(c) <= 20 && !c.startsWith(" ")));
  assert.equal(estimatedTokens("ありがとう"), 5);
});

test("a client delegation's task: the conversation, then what has been said since", () => {
  assert.equal(
    renderTranscriptRequest(
      [
        { role: "assistant", text: "Hello, Acme Dental." },
        { role: "user", text: "Can I book for Tuesday?" },
      ],
      true,
    ),
    "Voice conversation so far:\nASSISTANT: Hello, Acme Dental.\nUSER: Can I book for Tuesday?\n\nAct on the user's most recent request in the conversation above.",
  );
  assert.equal(
    renderTranscriptRequest([{ role: "user", text: "Ten, please." }], false),
    "Voice conversation since the previous delegation:\nUSER: Ten, please.\n\nAct on the user's most recent request in the conversation above.",
  );
  assert.equal(renderTranscriptRequest([], false), "Act on the user's most recent request in the conversation above.");
});

test("subagent results become the text to speak", () => {
  assert.equal(subagentAnswerText({ text: "Tuesday at ten." }), "Tuesday at ten.");
  assert.equal(subagentAnswerText({ answer: "", summary: "Booked." }), "Booked.");
  assert.equal(subagentAnswerText({ slots: [1, 2] }), '{"slots":[1,2]}');
  assert.equal(subagentAnswerText(undefined), "");
  assert.equal(subagentAnswerText("plain"), "plain");
});

test("stranded calls are read from the backend's error message", () => {
  assert.deepEqual(missingCallIds("Missing function call outputs for: call_a1, call_b2, call_a1."), ["call_a1", "call_b2"]);
  assert.deepEqual(missingCallIds(undefined), []);
  assert.equal(JSON.parse(droppedOutputStub("call_a1")).call_id, "call_a1");
});
