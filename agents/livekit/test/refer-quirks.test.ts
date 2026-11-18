import { test } from "node:test";
import assert from "node:assert/strict";
import { SipCallError } from "livekit-server-sdk";
import { isReferFalseFailure } from "../lib/refer-quirks.js";

// run: npx tsx --test test/refer-quirks.test.ts

function sipCallError(code: string, status: string, extra: Record<string, string> = {}) {
  return new SipCallError("Internal Server Error", "transfer failed", 500, "failed_precondition", {
    sip_status_code: code,
    sip_status: status,
    ...extra,
  });
}

test("a SipCallError with SIP status 500 is a false failure", () => {
  const err = sipCallError("500", "Internal Server Error", {
    sip_transfer_id: "STR_test",
    sip_transfer_reason: "STR_REJECTED",
  });
  assert.equal(
    err.message,
    "SIP call failed: 500 Internal Server Error (failed_precondition) [sip_transfer_id=STR_test, sip_transfer_reason=STR_REJECTED]",
  );
  assert.equal(isReferFalseFailure(err), true);
});

test("the same text without the SipCallError type is a false failure", () => {
  assert.equal(
    isReferFalseFailure(new Error("SIP call failed: 500 Internal Server Error (failed_precondition)")),
    true,
  );
});

test("the message format of livekit-server-sdk before 2.17 is still a false failure", () => {
  assert.equal(isReferFalseFailure(new Error("500: Internal Server Error")), true);
  assert.equal(
    isReferFalseFailure(new Error("twirp error unknown: participant does not exist")),
    true,
  );
});

test("a real rejection is not a false failure", () => {
  assert.equal(isReferFalseFailure(sipCallError("486", "Busy Here")), false);
  assert.equal(isReferFalseFailure(sipCallError("503", "Service Unavailable")), false);
  assert.equal(isReferFalseFailure(new Error("SIP call failed: 5000 Internal Server Error")), false);
  assert.equal(isReferFalseFailure(new Error("request timed out")), false);
  assert.equal(isReferFalseFailure(undefined), false);
  assert.equal(isReferFalseFailure("participant does not exist"), false);
});
