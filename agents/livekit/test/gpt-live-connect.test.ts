import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { APIStatusError, initializeLogger, llm } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { GptLiveRealtimeModel, handshakeErrorCode } from "../lib/gpt-live-model.js";

// agents-js 1.9 GPTLiveSession drops a refused handshake's HTTP status, so a revoked key logged
// only "GPT-Live connection failed". Offline: a local server that refuses the upgrade.
// run: npx tsx --test test/gpt-live-connect.test.ts

initializeLogger({ pretty: false, level: "fatal" });

const KEY = "sk-test-do-not-log";

const REFUSALS: Record<string, { status: number; body: string }> = {
  "401": {
    status: 401,
    body: JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${KEY}.`,
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    }),
  },
  "429": {
    status: 429,
    body: JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }),
  },
  "503": { status: 503, body: "upstream unavailable" },
};

let server: http.Server;
let port: number;
const upgrades: Record<string, number> = {};
const authHeaders: string[] = [];

before(async () => {
  server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const mode = req.url!.split("/")[1];
    upgrades[mode] = (upgrades[mode] ?? 0) + 1;
    authHeaders.push(String(req.headers.authorization));
    const { status, body } = REFUSALS[mode];
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
        `Content-Type: application/json\r\nx-request-id: req_test\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as net.AddressInfo).port;
});
after(() => server.close());

function liveModel(mode: string) {
  const model = new GptLiveRealtimeModel(
    new openai.realtime.GPTLiveModel({
      apiKey: KEY,
      baseURL: `http://127.0.0.1:${port}/${mode}/v1`,
      connOptions: { maxRetry: 3, retryIntervalMs: 50, timeoutMs: 5_000 },
    }),
    { overrides: {}, usageBackend: { vendor: "openai", detail: "openai/gpt-5" }, recovery: false },
  );
  const ended: { reason?: string }[] = [];
  model.setProviderEndedCallback((info) => ended.push(info));
  return { model, ended };
}

const nextError = (session: llm.RealtimeSession) =>
  once(session, "error").then(([ev]) => ev as llm.RealtimeModelError);

test("a 401 handshake reports its status and OpenAI code, and is not retried", async () => {
  const { model, ended } = liveModel("401");
  const session = model.session();
  try {
    const ev = await nextError(session);
    assert.ok(ev.error instanceof APIStatusError, `got ${ev.error?.constructor?.name}`);
    assert.equal(ev.error.message, "GPT-Live connection failed: HTTP 401 invalid_api_key");
    assert.equal(ev.error.statusCode, 401);
    assert.equal(ev.error.requestId, "req_test");
    assert.equal(ev.recoverable, false);
    assert.deepEqual(ended, [{ reason: "GPT-Live connection failed: HTTP 401 invalid_api_key" }]);
    // Give a wrongly scheduled retry time to arrive.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(upgrades["401"], 1);
  } finally {
    await session.close();
  }
});

test("the key reaches the server but never the error", async () => {
  const { model } = liveModel("401");
  const session = model.session();
  try {
    const ev = await nextError(session);
    assert.ok(authHeaders.includes(`Bearer ${KEY}`));
    const seen = JSON.stringify({ ...ev.error, message: ev.error.message, text: String(ev.error) });
    assert.ok(!seen.includes(KEY), seen);
  } finally {
    await session.close();
  }
});

test("a 429 is still retried, with its status and code", async () => {
  const { model, ended } = liveModel("429");
  const session = model.session();
  try {
    const ev = await nextError(session);
    assert.equal(ev.error.message, "GPT-Live connection failed: HTTP 429 insufficient_quota");
    assert.equal((ev.error as APIStatusError).statusCode, 429);
    assert.equal(ev.recoverable, true);
    assert.equal(ended.length, 0);
    await nextError(session);
    assert.ok(upgrades["429"] >= 2);
  } finally {
    await session.close();
  }
});

test("a refusal with a body that is not JSON still reports the status", async () => {
  const { model } = liveModel("503");
  const session = model.session();
  try {
    const ev = await nextError(session);
    assert.equal(ev.error.message, "GPT-Live connection failed: HTTP 503");
    assert.equal(ev.recoverable, true);
  } finally {
    await session.close();
  }
});

test("handshakeErrorCode takes only a short code or type", () => {
  assert.equal(handshakeErrorCode('{"error":{"code":"invalid_api_key","type":"x"}}'), "invalid_api_key");
  assert.equal(handshakeErrorCode('{"error":{"code":null,"type":"invalid_request_error"}}'), "invalid_request_error");
  assert.equal(handshakeErrorCode('{"error":{"code":"Incorrect API key provided: sk-1"}}'), undefined);
  assert.equal(handshakeErrorCode('{"error":"nope"}'), undefined);
  assert.equal(handshakeErrorCode("null"), undefined);
  assert.equal(handshakeErrorCode("<html>"), undefined);
});
