import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createCall, setBeforeCallEnd } from "../lib/api-client.js";
import logger from "../lib/logger.js";

// call.end() runs the before-end hook (the transcript time corrections)
// first, then sends the corrected batched rows and the stored-row corrections
// in the one end request, so the API applies them before the end hook.
// run: npx tsx --test test/call-end-corrections.test.ts

logger.level = "silent";

const realFetch = globalThis.fetch;
let endBodies: any[] = [];

before(() => {
  process.env.SERVICE_BASE_URI = "http://aplisay.test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/agent-db/call")) {
      return Response.json({ id: "call-1", userId: "user-1", organisationId: "org-1" });
    }
    if (url.endsWith("/api/agent-db/call/call-1/end") && init?.method === "POST") {
      endBodies.push(JSON.parse(String(init.body)));
      return Response.json({ message: "Call ended successfully" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  endBodies = [];
  setBeforeCallEnd(null);
});

after(() => {
  globalThis.fetch = realFetch;
});

const newCall = () =>
  createCall({
    userId: "user-1",
    organisationId: "org-1",
    instanceId: "instance-1",
    agentId: "agent-1",
    platform: "livekit",
  });

test("the hook runs before the end request and its changes are sent", async () => {
  const call: any = await newCall();
  const entry = { type: "user", data: '"Hello"', createdAt: new Date(2_000) };
  call.batchedTransactionLogs = [entry];
  setBeforeCallEnd(async (c: any) => {
    assert.equal(endBodies.length, 0);
    entry.createdAt = new Date(1_500);
    c.transactionLogCorrections = [{ id: 7, createdAt: new Date(900) }];
  });

  await call.end("normal");

  assert.equal(endBodies.length, 1);
  assert.equal(endBodies[0].transactionLogs[0].createdAt, new Date(1_500).toISOString());
  assert.deepEqual(endBodies[0].transactionLogCorrections, [{ id: 7, createdAt: new Date(900).toISOString() }]);
});

test("a failing hook still ends the call", async () => {
  const call = await newCall();
  setBeforeCallEnd(async () => {
    throw new Error("boom");
  });

  await call.end("normal");

  assert.equal(endBodies.length, 1);
  assert.equal(endBodies[0].transactionLogCorrections, undefined);
});

test("ends called together share one request while the hook runs", async () => {
  const call = await newCall();
  let release!: () => void;
  setBeforeCallEnd(() => new Promise<void>((resolve) => (release = resolve)));

  const first = call.end("a");
  const second = call.end("b");
  release();
  await Promise.all([first, second]);

  assert.equal(endBodies.length, 1);
  assert.equal(endBodies[0].reason, "a");
});
