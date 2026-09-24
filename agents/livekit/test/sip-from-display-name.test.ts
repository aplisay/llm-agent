import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSipDisplayName,
  sipFromDisplayName,
} from "../lib/sip-attributes.js";

// metadata.aplisay.callerIdName — the display-name from the inbound INVITE's
// From header, read from the `sip.h.from` participant attribute (the inbound
// trunk maps ALL headers, see initialise.ts). See docs/caller-id-name.md.
// run: npx tsx --test test/sip-from-display-name.test.ts

test("quoted-string display-name", () => {
  assert.equal(
    parseSipDisplayName(
      '"Alice Smith" <sip:+441632960001@sbc.example.com>;tag=1928301774',
    ),
    "Alice Smith",
  );
});

test("bare-token display-name", () => {
  assert.equal(
    parseSipDisplayName("Alice Smith <sip:+441632960001@sbc.example.com>;tag=1"),
    "Alice Smith",
  );
});

test("quoted-pairs are unescaped", () => {
  assert.equal(
    parseSipDisplayName('"Smith, \\"Ali\\" \\\\ Co" <sip:a@b>'),
    'Smith, "Ali" \\ Co',
  );
});

test("UTF-8 names pass through", () => {
  assert.equal(parseSipDisplayName('"Zoë Müller" <sip:z@b>'), "Zoë Müller");
});

test("tel: URIs in name-addr form", () => {
  assert.equal(parseSipDisplayName('"Bob" <tel:+441632960002>'), "Bob");
});

test("whitespace is collapsed and control characters dropped", () => {
  const tab = String.fromCharCode(9);
  const soh = String.fromCharCode(1);
  assert.equal(
    parseSipDisplayName('"  Alice ' + tab + '  Smith' + soh + ' " <sip:a@b>'),
    "Alice Smith",
  );
  assert.equal(parseSipDisplayName("Alice   Smith   <sip:a@b>"), "Alice Smith");
});

test("no display-name -> undefined", () => {
  for (const v of [
    "<sip:+441632960001@sbc.example.com>;tag=x",
    "sip:+441632960001@sbc.example.com;tag=x",
    "sips:alice@example.com",
    '"" <sip:a@b>',
    '"   " <sip:a@b>',
    "   <sip:a@b>",
    "",
    undefined,
    null,
  ]) {
    assert.equal(parseSipDisplayName(v), undefined, JSON.stringify(v));
  }
});

test("malformed quoted-string -> undefined", () => {
  assert.equal(parseSipDisplayName('"Alice <sip:a@b>'), undefined);
  assert.equal(parseSipDisplayName('"Alice" sip:a@b'), undefined);
  assert.equal(parseSipDisplayName('"Alice"'), undefined);
});

test("sipFromDisplayName reads sip.h.from (dotted wins over camelCase)", () => {
  assert.equal(
    sipFromDisplayName({
      "sip.phoneNumber": "+441632960001",
      "sip.h.x-aplisay-trunk": "tk",
      "sip.h.from": '"Alice Smith" <sip:+441632960001@sbc.example.com>;tag=1',
      sipHFrom: '"Wrong" <sip:x@y>',
    }),
    "Alice Smith",
  );
  assert.equal(
    sipFromDisplayName({ sipHFrom: "Legacy Camel <sip:x@y>;tag=1" }),
    "Legacy Camel",
  );
});

test("sipFromDisplayName -> undefined without the attribute", () => {
  assert.equal(sipFromDisplayName({ "sip.phoneNumber": "+441632960001" }), undefined);
  assert.equal(sipFromDisplayName({}), undefined);
  assert.equal(sipFromDisplayName(undefined), undefined);
  // A From with no display-name.
  assert.equal(
    sipFromDisplayName({ "sip.h.from": "<sip:+441632960001@sbc.example.com>;tag=1" }),
    undefined,
  );
});
