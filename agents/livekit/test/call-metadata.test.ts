import { test } from "node:test";
import assert from "node:assert/strict";
import { sealJoinMetadata } from "../agent-lib/join-metadata.js";
import { jobCallMetadata, mergeCallMetadata } from "../lib/call-metadata.js";

// POST /listener/{id}/join options.metadata reaches a WebRTC call's metadata
// sealed in the token's agent dispatch (lib/handlers/livekit.js).
// run: node --import tsx --test test/call-metadata.test.ts

const SECRET = "test-livekit-api-secret-0123456789";
const INSTANCE_ID = "dc5e7c37-e644-45d3-80ec-12292dc1ea70";

const joinDispatch = (metadata: object) => ({
  identity: INSTANCE_ID,
  metadata: INSTANCE_ID,
  sealedCallMetadata: sealJoinMetadata(metadata, SECRET),
});

const PLATFORM = { callerId: "WebRTC", calledId: "WebRTC", model: "livekit:ultravox/ultravox-v0.7" };

test("a WebRTC join's metadata is merged over the listener activation's", () => {
  const callMetadata = jobCallMetadata(
    joinDispatch({ simplyai: { agent_key: "ak-123" }, shared: "from-join" }),
    SECRET,
  );
  assert.deepEqual(
    mergeCallMetadata({ shared: "from-activation", crm: { tier: "gold" } }, callMetadata, PLATFORM),
    {
      shared: "from-join",
      crm: { tier: "gold" },
      simplyai: { agent_key: "ak-123" },
      aplisay: PLATFORM,
    },
  );
});

test("a caller cannot override the platform's aplisay block", () => {
  const callMetadata = jobCallMetadata(
    joinDispatch({ aplisay: { callerId: "+15550000000", injected: true } }),
    SECRET,
  );
  assert.deepEqual(mergeCallMetadata({ aplisay: { stale: true } }, callMetadata, PLATFORM), {
    aplisay: PLATFORM,
  });
});

test("the dispatch metadata does not carry the join metadata in plain text", () => {
  const dispatch = JSON.stringify(joinDispatch({ simplyai: { agent_key: "ak-123" } }));
  assert.ok(!dispatch.includes("ak-123"));
  assert.ok(!dispatch.includes("agent_key"));
});

test("an originate's plain callMetadata still passes through", () => {
  assert.deepEqual(jobCallMetadata({ outbound: true, callMetadata: { crm: "x" } }, SECRET), {
    crm: "x",
  });
});

test("a WebRTC join without metadata yields none", () => {
  assert.deepEqual(jobCallMetadata({ identity: INSTANCE_ID, metadata: INSTANCE_ID }, SECRET), {});
  assert.deepEqual(mergeCallMetadata(undefined, {}, PLATFORM), { aplisay: PLATFORM });
});

test("a value sealed with another secret, or altered, does not open", () => {
  const job = joinDispatch({ crm: "x" });
  assert.throws(() => jobCallMetadata(job, "some-other-livekit-api-secret"));
  assert.throws(() => jobCallMetadata(job, undefined), /no secret/);

  const body = job.sealedCallMetadata.slice(3);
  const flipped = body.slice(0, -2) + (body.at(-2) === "A" ? "B" : "A") + body.at(-1);
  assert.throws(() => jobCallMetadata({ ...job, sealedCallMetadata: `v1.${flipped}` }, SECRET));
  assert.throws(() => jobCallMetadata({ ...job, sealedCallMetadata: "v2.abc" }, SECRET), /known format/);
});
