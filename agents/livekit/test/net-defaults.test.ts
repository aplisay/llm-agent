import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dns from "node:dns";
import {
  OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS,
  OUTBOUND_DNS_RESULT_ORDER,
  outboundNetworkDefaults,
} from "../lib/net-defaults.js";

// Node ≥20 walks every resolved address with a 250ms per-address connect budget and
// throws AggregateError [ETIMEDOUT] when the list is exhausted — surfacing as
// "TypeError: fetch failed". The runner's API host advertises an AAAA the VM cannot
// route (ENETUNREACH in ~1ms), so IPv4 was left a 250ms budget; a SYN slower than that
// failed the request before it reached the server. Observed on staging on both
// /api/agent-db/call (aborting a warm transfer) and /api/agent-db/transaction-log.
// run: npx tsx --test test/net-defaults.test.ts

test("importing the module applies the attempt timeout as a side effect", () => {
  // Load order matters: realtime.ts imports this first so the default is in force
  // before anything opens a socket.
  assert.equal(
    net.getDefaultAutoSelectFamilyAttemptTimeout(),
    OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS,
  );
});

test("the budget is 5s — slow request, not hard failure", () => {
  assert.equal(OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS, 5_000);
  // Comfortably above the 250ms default that caused the failures...
  assert.ok(OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS > 250);
  // ...and inside undici's own ~10s connect timeout, which stays the real backstop.
  assert.ok(OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS < 10_000);
});

test("IPv4 is preferred, so the unroutable AAAA never delays a request", () => {
  assert.equal(OUTBOUND_DNS_RESULT_ORDER, "ipv4first");
  assert.equal(dns.getDefaultResultOrder(), "ipv4first");
});

test("happy-eyeballs stays ENABLED", () => {
  // Load-bearing. Disabling autoSelectFamily would make the attempt timeout inert —
  // it only governs the multi-address walk — and would turn any future IPv4 problem
  // into an immediate hard failure instead of falling back to IPv6.
  assert.equal(net.getDefaultAutoSelectFamily(), true);
});

test("outboundNetworkDefaults reports what is actually in force", () => {
  // Read back from node:net rather than echoing our own constants, so the startup log
  // cannot claim a setting that was not applied.
  assert.deepEqual(outboundNetworkDefaults(), {
    dnsResultOrder: "ipv4first",
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeoutMs: 5_000,
  });
});
