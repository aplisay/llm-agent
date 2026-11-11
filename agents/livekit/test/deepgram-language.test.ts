import { test } from "node:test";
import assert from "node:assert/strict";
import { initializeLogger } from "@livekit/agents";

// The `language` the provider-keys Deepgram STT is built with, for the primary and side engines.
// run: node --import tsx --test test/deepgram-language.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const { deepgramSttLanguage } = await import("../lib/pipeline-provider-keys.js");
const { auxSttAgent, outputSttAgent, errorText } = await import("../lib/aux-stt.js");

const withStt = (language?: string) => ({ prompt: "p", options: language === undefined ? {} : { stt: { language } } }) as any;

test("Deepgram regional models are sent as region tags, normalised", () => {
  for (const [given, sent] of [
    ["en-GB", "en-GB"],
    ["en-gb", "en-GB"],
    ["en_GB", "en-GB"],
    ["en-AU", "en-AU"],
    ["fr-CA", "fr-CA"],
    ["es-419", "es-419"],
    ["pt-BR", "pt-BR"],
  ]) {
    assert.equal(deepgramSttLanguage(withStt(given)), sent, given);
  }
});

test("a region tag Deepgram refuses falls back to its base language", () => {
  for (const [given, sent] of [
    ["en-IE", "en-US"],
    ["en-CA", "en-US"],
    ["en-ZA", "en-US"],
    ["fi-FI", "fi"],
    ["hi-IN", "hi"],
    ["uk-UA", "uk"],
    ["el-GR", "el"],
    ["de-DE", "de"],
    ["nb-NO", "no"],
    ["nb", "no"],
    ["zh-Hant", "zh"],
  ]) {
    assert.equal(deepgramSttLanguage(withStt(given)), sent, given);
  }
});

test("no language, or a no-fixed-language sentinel, keeps en-US", () => {
  assert.equal(deepgramSttLanguage(withStt()), "en-US");
  assert.equal(deepgramSttLanguage(withStt("")), "en-US");
  assert.equal(deepgramSttLanguage(withStt("multi")), "en-US");
});

test("side engines that inherit tts.language get a language Deepgram accepts", () => {
  const agent = { prompt: "p", options: { tts: { vendor: "ultravox", voice: "Ciara", language: "en-IE" } } } as any;
  assert.equal(deepgramSttLanguage(auxSttAgent(agent, {})), "en-US");
  assert.equal(deepgramSttLanguage(outputSttAgent(agent, {})), "en-US");
  assert.equal(deepgramSttLanguage(auxSttAgent(agent, { language: "en-GB" })), "en-GB");
});

test("errorText keeps the message of a thrown Error", () => {
  assert.equal(errorText(new Error("STT must be Deepgram")), "STT must be Deepgram");
  assert.equal(errorText("plain"), "plain");
});
