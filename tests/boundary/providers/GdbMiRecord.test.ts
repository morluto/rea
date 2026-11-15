import { expect, it } from "vitest";
import {
  gdbMiConstText,
  gdbMiResultHeader,
  parseGdbMiDoneRecord,
  parseGdbMiResultRecord,
  parseGdbMiStreamRecord,
} from "../../../src/gdb/GdbMiRecord.js";

const text = (value: string) => ({
  kind: "const",
  bytes: Uint8Array.from(Buffer.from(value, "utf8")),
});

it("parses a tokenized record into typed results", () => {
  expect(
    parseGdbMiResultRecord(
      '12^done,a="x",t={b="y"},l=["1",{}],r=[c="z",c="w"],e=[]',
    ),
  ).toEqual({
    ok: true,
    value: {
      token: "12",
      resultClass: "done",
      results: [
        { name: "a", value: text("x") },
        {
          name: "t",
          value: { kind: "tuple", results: [{ name: "b", value: text("y") }] },
        },
        {
          name: "l",
          value: {
            kind: "list",
            values: [text("1"), { kind: "tuple", results: [] }],
          },
        },
        {
          name: "r",
          value: {
            kind: "result-list",
            results: [
              { name: "c", value: text("z") },
              { name: "c", value: text("w") },
            ],
          },
        },
        { name: "e", value: { kind: "list", values: [] } },
      ],
    },
  });
});

it.each([
  ["no result class", "12", "line is not an MI result record"],
  ["unknown class", "12^stopped", "line is not an MI result record"],
  ["class with a suffix", "12^donex", "line is not an MI result record"],
  ["trailing bytes", '12^done,a="x"junk', "expected ',' between results"],
  ["missing variable", '12^done,="x"', "expected variable="],
  ["bare word value", "12^done,a=x", "expected a C-string, tuple or list"],
  ["unterminated string", '12^done,a="x', "unterminated C-string"],
  ["unclosed list", '12^done,a=["x"', "expected ',' or ']'"],
  ["mixed list items", '12^done,a=[b="x","y"]', "expected variable="],
  ["invalid escape", '12^done,a="\\q"', "invalid C-string escape"],
  ["empty hex escape", '12^done,a="\\x"', "\\x escape without hex digits"],
  ["raw control", '12^done,a="\t"', "unescaped control character in C-string"],
])("refuses %s as a typed MI record failure", (_label, line, reason) => {
  const parsed = parseGdbMiResultRecord(line);
  expect(parsed).toMatchObject({
    ok: false,
    error: { kind: "malformed-mi-record", reason },
  });
});

it("bounds value nesting", () => {
  const nested = "[".repeat(257) + "]".repeat(257);
  expect(parseGdbMiResultRecord(`1^done,a=${nested}`)).toMatchObject({
    ok: false,
    error: { reason: "MI value nesting exceeds the parser bound" },
  });
  const allowed = "[".repeat(256) + "]".repeat(256);
  expect(parseGdbMiResultRecord(`1^done,a=${allowed}`).ok).toBe(true);
});

it("decodes C-string escapes to bytes and text only when UTF-8", () => {
  const parsed = parseGdbMiResultRecord(
    '1^done,a="\\x41\\101\\n\\\\\\"",b="\\xff",c="\\x1ff"',
  );
  if (!parsed.ok) throw new Error(parsed.error.reason);
  const [a, b, c] = parsed.value.results;
  expect(gdbMiConstText(a!.value)).toBe('AA\n\\"');
  expect(gdbMiConstText(b!.value)).toBeUndefined();
  expect(c!.value).toEqual({ kind: "const", bytes: Uint8Array.of(0xff) });
});

it.each([
  ['3^done,a="x"', true],
  ["3^done", true],
  ["^done", false],
  ['3^error,msg="no"', false],
  ["3^done,garbage", false],
])("admits only a well-formed tokenized done record: %s", (line, done) => {
  expect(parseGdbMiDoneRecord(line).ok).toBe(done);
});

it.each([
  ["7^running", { token: 7, resultClass: "running" }],
  ['7^error,msg="x"', { token: 7, resultClass: "error" }],
  ["^done", undefined],
  ["7^doneish", undefined],
  ['~"7^done"', undefined],
])("reads the correlation header of %s", (line, header) => {
  expect(gdbMiResultHeader(line)).toEqual(header);
});

it("keeps byte order across interleaved runs and escapes", () => {
  const parsed = parseGdbMiResultRecord(
    '1^done,a="ab\\x41z\u{1F680}\\101\\n",b="\uD83D"',
  );
  expect(parsed).toMatchObject({
    ok: false,
    error: { reason: "lone surrogate in C-string" },
  });
  const valid = parseGdbMiResultRecord('1^done,a="ab\\x41z\u{1F680}\\101\\n"');
  if (!valid.ok) throw new Error(valid.error.reason);
  expect(gdbMiConstText(valid.value.results[0]!.value)).toBe(
    "abAz\u{1F680}A\n",
  );
});

it.each([
  ['~"GNU gdb\\n"', { kind: "console", text: "GNU gdb\n" }],
  ['@"target"', { kind: "target", text: "target" }],
  ['&"log"', { kind: "log", text: "log" }],
  ['~"unterminated', undefined],
  ['~"a"b', undefined],
  ['=thread-group-added,id="i1"', undefined],
  ["~bare", undefined],
])("reads the stream record %s", (line, expected) => {
  const parsed = parseGdbMiStreamRecord(line);
  if (expected === undefined) {
    expect(parsed.ok).toBe(false);
    return;
  }
  if (!parsed.ok) throw new Error(parsed.error.reason);
  expect(parsed.value.kind).toBe(expected.kind);
  expect(gdbMiConstText(parsed.value.value)).toBe(expected.text);
});
