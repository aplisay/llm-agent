import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySipIdentity,
  pickSipIdentityFlags,
  sipHost,
  toE164,
  transferSipIdentity,
} from "../lib/sip-identity.js";

// run: npx tsx --test test/sip-identity.test.ts

const AGENT = "441632960001";
const CALLER = "447700900123";
const SBC = "sbc.example.com:5061";

test("pickSipIdentityFlags keeps only the identity flags set to true", () => {
  assert.deepEqual(
    pickSipIdentityFlags({
      sendPai: true,
      sendRpid: "yes",
      fromOriginalCaller: true,
      useTelUriId: true,
      canRefer: true,
    }),
    { sendPai: true, fromOriginalCaller: true, useTelUriId: true },
  );
  assert.equal(pickSipIdentityFlags({ canRefer: true }), null);
  assert.equal(pickSipIdentityFlags(null), null);
  assert.equal(pickSipIdentityFlags("sendPai"), null);
});

test("toE164 normalises numbers and URIs", () => {
  assert.equal(toE164("+441632960001"), "+441632960001");
  assert.equal(toE164("441632960001"), "+441632960001");
  assert.equal(toE164("01632960001"), "+441632960001");
  assert.equal(toE164("00441632960001"), "+441632960001");
  assert.equal(toE164("+44 1632 960001"), "+441632960001");
  assert.equal(toE164("sip:+441632960001@sbc.example.com;user=phone"), "+441632960001");
  assert.equal(toE164("<tel:+441632960001>"), "+441632960001");
});

test("toE164 rejects what is not an E.164 number", () => {
  for (const n of ["", "anonymous", "unknown", "8091", "+0441632960001", "+1234567890123456", null, undefined]) {
    assert.equal(toE164(n as string | null | undefined), null, String(n));
  }
});

test("no flags: From unchanged and no headers", () => {
  assert.deepEqual(applySipIdentity(null, "+441632960001"), {
    fromNumber: "+441632960001",
    headers: {},
    assertedNumberRejected: false,
  });
  assert.deepEqual(
    applySipIdentity({ flags: null, assertedNumber: AGENT }, "+441632960001").headers,
    {},
  );
});

test("sipHost takes the host from an address", () => {
  assert.equal(sipHost("sbc.example.com"), "sbc.example.com");
  assert.equal(sipHost("sbc.example.com:5061"), "sbc.example.com");
  assert.equal(sipHost("sip:sbc.example.com:5061;transport=tls"), "sbc.example.com");
  assert.equal(sipHost("sip:user@192.0.2.10:5070"), "192.0.2.10");
  assert.equal(sipHost("[2001:db8::1]:5060"), "[2001:db8::1]");
  assert.equal(sipHost(""), null);
  assert.equal(sipHost(null), null);
});

test("sendPai adds P-Asserted-Identity as a named sip URI on the next hop", () => {
  const r = applySipIdentity({ flags: { sendPai: true }, assertedNumber: AGENT }, "+441632960001", SBC);
  assert.deepEqual(r.headers, {
    "P-Asserted-Identity": '"+441632960001" <sip:+441632960001@sbc.example.com>',
  });
  assert.equal(r.fromNumber, "+441632960001");
});

test("with no host the URI is tel:", () => {
  const r = applySipIdentity({ flags: { sendPai: true }, assertedNumber: AGENT }, AGENT);
  assert.deepEqual(r.headers, { "P-Asserted-Identity": "<tel:+441632960001>" });
});

test("useTelUriId keeps the tel: URI even with a host", () => {
  const r = applySipIdentity(
    { flags: { sendPai: true, sendRpid: true, useTelUriId: true }, assertedNumber: AGENT },
    AGENT,
    SBC,
  );
  assert.deepEqual(r.headers, {
    "P-Asserted-Identity": "<tel:+441632960001>",
    "Remote-Party-ID": "<tel:+441632960001>;party=calling;screen=yes;privacy=off",
  });
});

test("sendRpid adds Remote-Party-ID", () => {
  const r = applySipIdentity({ flags: { sendRpid: true }, assertedNumber: AGENT }, AGENT, SBC);
  assert.deepEqual(r.headers, {
    "Remote-Party-ID":
      '"+441632960001" <sip:+441632960001@sbc.example.com>;party=calling;screen=yes;privacy=off',
  });
});

test("fromOriginalCaller with PAI: From is the caller, PAI the agent", () => {
  const r = applySipIdentity(
    {
      flags: { sendPai: true, fromOriginalCaller: true },
      assertedNumber: AGENT,
      originalCaller: CALLER,
    },
    "+441632960001",
    SBC,
  );
  assert.equal(r.fromNumber, "+447700900123");
  assert.equal(r.headers["P-Asserted-Identity"], '"+441632960001" <sip:+441632960001@sbc.example.com>');
});

test("fromOriginalCaller alone changes From and adds no headers", () => {
  const r = applySipIdentity(
    { flags: { fromOriginalCaller: true }, assertedNumber: AGENT, originalCaller: CALLER },
    "+441632960001",
    SBC,
  );
  assert.equal(r.fromNumber, "+447700900123");
  assert.deepEqual(r.headers, {});
});

test("a withheld original caller leaves From as the agent", () => {
  const r = applySipIdentity(
    {
      flags: { sendPai: true, fromOriginalCaller: true },
      assertedNumber: AGENT,
      originalCaller: "anonymous",
    },
    "+441632960001",
  );
  assert.equal(r.fromNumber, "+441632960001");
});

test("an unusable agent number sends no headers", () => {
  const r = applySipIdentity(
    { flags: { sendPai: true, sendRpid: true }, assertedNumber: "8091" },
    "8091",
    SBC,
  );
  assert.deepEqual(r, { fromNumber: "8091", headers: {}, assertedNumberRejected: true });
});

test("an unusable agent number does not stop fromOriginalCaller", () => {
  const r = applySipIdentity(
    {
      flags: { sendPai: true, fromOriginalCaller: true },
      assertedNumber: "8091",
      originalCaller: CALLER,
    },
    "8091",
    SBC,
  );
  assert.deepEqual(r, { fromNumber: "+447700900123", headers: {}, assertedNumberRejected: true });
});

test("transfer on an inbound call asserts the inbound DDI", () => {
  const id = transferSipIdentity(
    { callerId: CALLER, calledId: AGENT, sipIdentityFlags: { sendPai: true } },
    "441632960099",
  );
  assert.deepEqual(id, {
    flags: { sendPai: true },
    assertedNumber: AGENT,
    originalCaller: CALLER,
  });
});

test("transfer on an originated call asserts the originating number", () => {
  const id = transferSipIdentity(
    { outbound: true, callerId: AGENT, calledId: CALLER, sipIdentityFlags: { sendPai: true } },
    CALLER,
  );
  assert.equal(id?.assertedNumber, AGENT);
  assert.equal(id?.originalCaller, CALLER);
});

test("transfer with no DDI (WebRTC) asserts the validated caller id", () => {
  const id = transferSipIdentity(
    { callerId: "unknown", calledId: "c6d1e5a0-agent-room", sipIdentityFlags: null },
    AGENT,
    { sendPai: true },
  );
  assert.equal(id?.assertedNumber, AGENT);
});

test("a caller id on another egress uses that egress's flags", () => {
  const ctx = { callerId: CALLER, calledId: AGENT, sipIdentityFlags: { sendPai: true } };
  assert.equal(transferSipIdentity(ctx, AGENT, null), null);
  assert.deepEqual(transferSipIdentity(ctx, AGENT, { sendRpid: true })?.flags, { sendRpid: true });
  assert.deepEqual(transferSipIdentity(ctx, AGENT)?.flags, { sendPai: true });
});
