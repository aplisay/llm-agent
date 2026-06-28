import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

import {
  ValidationError,
  validateDestination,
  validateCallerId,
  validateToken,
  validateUuid,
  validateOriginateBody,
  validateTransferBody,
} from "../validate.js";
import { buildCallApi } from "../call-api.js";

// A representative payload of ESL/dial-string injection attempts. Each one would
// break out of the `{k=v,k=v}` channel-variable block or append extra dialplan
// applications to the dial string if interpolated unescaped into a bgapi command.
const MALICIOUS_DESTINATIONS = [
  "1234 &lua(/tmp/evil.lua)", // space + & appends an application
  "1234&bridge(other)", // ampersand appends an application
  "1234,origination_caller_id_number=spoofed", // comma injects a channel var
  "1234}origination_privacy=yes{", // breaks out of the {...} block
  "1234'`whoami`", // quote/backtick
  "1234\nhangup", // newline
  "sip:a@h;t=1 &x", // metachar inside a SIP-looking value
  "; uuid_kill all", // leading semicolon + space
];

describe("validate — destination", () => {
  test("accepts E.164 numbers", () => {
    expect(validateDestination("+12025550123")).toBe("+12025550123");
    expect(validateDestination("12025550123")).toBe("12025550123");
  });

  test("accepts strict SIP URIs", () => {
    expect(validateDestination("sip:alice@example.com")).toBe("sip:alice@example.com");
    expect(validateDestination("sips:bob@1.2.3.4:5061;transport=tls")).toBe(
      "sips:bob@1.2.3.4:5061;transport=tls",
    );
  });

  test.each(MALICIOUS_DESTINATIONS)("rejects injection: %j", (value) => {
    expect(() => validateDestination(value)).toThrow(ValidationError);
  });

  test("rejects empty / non-string", () => {
    expect(() => validateDestination("")).toThrow(ValidationError);
    expect(() => validateDestination(undefined)).toThrow(ValidationError);
    expect(() => validateDestination(42)).toThrow(ValidationError);
  });
});

describe("validate — callerId / token / uuid", () => {
  test("callerId accepts numbers and short alpha ids, rejects metachars", () => {
    expect(validateCallerId("callerId", "+441234567890")).toBe("+441234567890");
    expect(validateCallerId("callerId", "Support")).toBe("Support");
    expect(() => validateCallerId("callerId", "a,b")).toThrow(ValidationError);
    expect(() => validateCallerId("callerId", "a b")).toThrow(ValidationError);
    expect(() => validateCallerId("callerId", "a'b")).toThrow(ValidationError);
  });

  test("token rejects metachars", () => {
    expect(validateToken("callId", "call-123_abc.9")).toBe("call-123_abc.9");
    expect(() => validateToken("callId", "x y")).toThrow(ValidationError);
    expect(() => validateToken("callId", "x&y")).toThrow(ValidationError);
  });

  test("uuid accepts a UUID, rejects anything else", () => {
    const u = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    expect(validateUuid("uuid", u)).toBe(u);
    expect(() => validateUuid("uuid", "not-a-uuid")).toThrow(ValidationError);
    expect(() => validateUuid("uuid", `${u} &x`)).toThrow(ValidationError);
  });
});

describe("validate — body validators", () => {
  test("originate body passes valid, rejects malicious destination", () => {
    const ok = validateOriginateBody({
      destination: "+12025550123",
      callerId: "+441234567890",
      callId: "call-1",
    });
    expect(ok.destination).toBe("+12025550123");

    expect(() =>
      validateOriginateBody({
        destination: "1234 &lua(x)",
        callerId: "+1",
        callId: "c",
      }),
    ).toThrow(ValidationError);
  });

  test("transfer body rejects bad operation and malicious callerIdOverride", () => {
    expect(() =>
      validateTransferBody({ destination: "+1", operation: "evil" as any }),
    ).toThrow(ValidationError);

    expect(() =>
      validateTransferBody({
        destination: "+1",
        operation: "bridge",
        callerIdOverride: "x'&y",
      }),
    ).toThrow(ValidationError);

    // empty callerIdOverride is tolerated (bridge path allows an empty CLI)
    const ok = validateTransferBody({
      destination: "+1",
      operation: "bridge",
      callerIdOverride: "",
    });
    expect(ok.callerIdOverride).toBe("");
  });
});

describe("call-api routes — injection is rejected before bgapi", () => {
  let bgapi: ReturnType<typeof jest.fn>;
  let app: ReturnType<typeof buildCallApi>;

  beforeEach(() => {
    bgapi = jest.fn(async () => ({ body: { response: "+OK" } }));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    app = buildCallApi({ client: { bgapi } as any, logger: logger as any });
  });

  test("POST /calls/originate rejects a malicious destination with 400", async () => {
    const res = await request(app)
      .post("/calls/originate")
      .send({ destination: "1234 &lua(/tmp/x.lua)", callerId: "+1", callId: "c1" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("destination");
    expect(bgapi).not.toHaveBeenCalled();
  });

  test("POST /calls/originate rejects a comma-injected callerId with 400", async () => {
    const res = await request(app)
      .post("/calls/originate")
      .send({ destination: "+12025550123", callerId: "1,evil=1", callId: "c1" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("callerId");
    expect(bgapi).not.toHaveBeenCalled();
  });

  test("POST /calls/originate accepts a clean payload and issues one bgapi", async () => {
    const res = await request(app)
      .post("/calls/originate")
      .send({ destination: "+12025550123", callerId: "+441234567890", callId: "c1" });
    expect(res.status).toBe(200);
    expect(bgapi).toHaveBeenCalledTimes(1);
    const cmd = bgapi.mock.calls[0][0] as string;
    expect(cmd).toContain("sofia/gateway/sbc/+12025550123");
  });

  test("POST /calls/:uuid/transfer rejects a malicious destination with 400", async () => {
    const uuid = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    const res = await request(app)
      .post(`/calls/${uuid}/transfer`)
      .send({ destination: "x &bridge(y)", operation: "refer" });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("destination");
    expect(bgapi).not.toHaveBeenCalled();
  });

  test("POST /calls/:uuid/transfer rejects a non-UUID path uuid with 400", async () => {
    const res = await request(app)
      .post(`/calls/${encodeURIComponent("abc &x")}/transfer`)
      .send({ destination: "+12025550123", operation: "refer" });
    expect(res.status).toBe(400);
    expect(bgapi).not.toHaveBeenCalled();
  });

  test("POST /calls/:uuid/transfer (refer) issues uuid_deflect for clean input", async () => {
    const uuid = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    const res = await request(app)
      .post(`/calls/${uuid}/transfer`)
      .send({ destination: "sip:agent@pbx.example.com", operation: "refer" });
    expect(res.status).toBe(200);
    const cmd = bgapi.mock.calls.at(-1)![0] as string;
    expect(cmd).toBe(`uuid_deflect ${uuid} sip:agent@pbx.example.com`);
  });
});
