// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRaw, encodeEol } from "../src/eol.ts";

const roundTrip = raw => {
  const d = decodeRaw(raw);
  return (d.bom ? "﻿" : "") + encodeEol(d.text, d.eol, new Map(d.odd));
};

test("mixed line endings survive a round trip", () => {
  for (const raw of ["a\r\nb\nc\r\nd", "﻿x\ry\r\nz\r\n", "", "one line", "\n\n\r\n"]) assert.equal(roundTrip(raw), raw);
});

test("dominant break wins, the others are remembered by offset", () => {
  const d = decodeRaw("a\r\nb\nc\r\n");
  assert.equal(d.text, "a\nb\nc\n");
  assert.equal(d.eol, "\r\n");
  assert.deepEqual(d.odd, [[3, "\n"]]);
});

test("a new line typed by the user gets the dominant break", () => {
  assert.equal(encodeEol("a\nNEW\nb", "\r\n", new Map([[5, "\n"]])), "a\r\nNEW\nb");
});
