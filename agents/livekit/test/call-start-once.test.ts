import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createCall } from "../lib/api-client.js";
import logger from "../lib/logger.js";

// A fallback retry reuses the job's call record, so call.start() runs again.
// A second POST /start would reset startedAt and resend the customer's start
// hook: a call starts once, but a failed start (busy) can be tried again.
// run: npx tsx --test test/call-start-once.test.ts

logger.level = "silent";

const realFetch = globalThis.fetch;
let startPosts = 0;
let startResponse: () => Response;

before(() => {
  process.env.SERVICE_BASE_URI = "http://aplisay.test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/agent-db/call")) {
      return Response.json({ id: "call-1", userId: "user-1", organisationId: "org-1" });
    }
    if (url.endsWith("/api/agent-db/call/call-1/start") && init?.method === "POST") {
      startPosts++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return startResponse();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  startPosts = 0;
  startResponse = () => Response.json({ message: "Call started successfully" });
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

test("a second start after a successful one makes no request", async () => {
  const call = await newCall();
  await call.start();
  await call.start();
  assert.equal(startPosts, 1);
});

test("starts in flight together share one request", async () => {
  const call = await newCall();
  await Promise.all([call.start(), call.start()]);
  assert.equal(startPosts, 1);
});

test("a busy start throws and can be tried again", async () => {
  const call = await newCall();
  startResponse = () =>
    Response.json(
      { error: "limit", code: "AGENT_CONCURRENCY_LIMIT_EXCEEDED", scope: "organisation" },
      { status: 429 },
    );
  await assert.rejects(call.start(), (e: any) => e.code === "AGENT_CONCURRENCY_LIMIT_EXCEEDED");
  startResponse = () => Response.json({ message: "Call started successfully" });
  await call.start();
  assert.equal(startPosts, 2);
});
