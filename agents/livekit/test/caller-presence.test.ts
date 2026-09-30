import { test } from "node:test";
import assert from "node:assert/strict";
import { callerLeftRoom } from "../lib/caller-presence.js";

// The worker stops the fallback chain when the caller hung up during a failed
// start: a retry would otherwise run in an empty room until the watchdog.
// run: npx tsx --test test/caller-presence.test.ts

const room = (connected: boolean, ...identities: string[]) => ({
  isConnected: connected,
  remoteParticipants: new Map(identities.map((identity) => [identity, { identity }])),
});

test("a caller still in the room has not left", () => {
  assert.equal(callerLeftRoom(room(true, "sip_caller", "other"), { identity: "sip_caller" }), false);
});

test("a caller missing from a connected room has left", () => {
  assert.equal(callerLeftRoom(room(true, "other"), { identity: "sip_caller" }), true);
  assert.equal(callerLeftRoom(room(true), { identity: "sip_caller" }), true);
});

test("an outbound call's dialled participant is matched by participantIdentity", () => {
  assert.equal(callerLeftRoom(room(true, "sip_callee"), { participantIdentity: "sip_callee" }), false);
  assert.equal(callerLeftRoom(room(true), { participantIdentity: "sip_callee" }), true);
});

test("unknown when the job has not joined the room, or there is no caller", () => {
  // A failure before the session started: the room is not connected yet.
  assert.equal(callerLeftRoom(room(false), { identity: "sip_caller" }), false);
  assert.equal(callerLeftRoom(room(true), null), false);
  assert.equal(callerLeftRoom(null, { identity: "sip_caller" }), false);
});
