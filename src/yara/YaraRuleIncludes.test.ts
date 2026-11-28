import { describe, expect, it } from "vitest";

import { YARA_INCLUDE_LEXER_CASES } from "../../tests/fixtures/yara/includeLexerCases.js";
import {
  MAX_RETAINED_DIRECTIVES,
  MAX_RETAINED_PATH_BYTES,
  createYaraIncludeScanner,
  type YaraIncludeScan,
} from "./YaraRuleIncludes.js";

const scan = (text: string | Uint8Array): YaraIncludeScan => {
  const scanner = createYaraIncludeScanner();
  scanner.push(typeof text === "string" ? Buffer.from(text, "utf8") : text);
  return scanner.finish();
};

/** The same text pushed one byte at a time must give the same result. */
const scanBytewise = (text: string): YaraIncludeScan => {
  const scanner = createYaraIncludeScanner();
  for (const byte of Buffer.from(text, "utf8"))
    scanner.push(Uint8Array.of(byte));
  return scanner.finish();
};

const at = (text: string): readonly string[] =>
  scan(text).directives.map(
    ({ line, column, path }) =>
      `${String(line)}:${String(column)} ${path ?? "null"}`,
  );

describe("createYaraIncludeScanner", () => {
  it("finds a top-level directive with its line, column and path", () => {
    expect(at('include "common.yar"\nrule A { condition: true }\n')).toEqual([
      "1:1 common.yar",
    ]);
    expect(at('rule A { condition: true }\n\t include \t "x.yar"')).toEqual([
      "2:3 x.yar",
    ]);
  });

  // libyara's `include[ \t]+\"` rule has no start condition, so it fires at
  // any token start in the initial state, inside a rule body too.
  it("finds a directive inside a rule body and after punctuation", () => {
    expect(at('rule A { condition: include "x.yar" }')).toEqual(["1:21 x.yar"]);
    expect(at('pe.include "x.yar"')).toEqual(["1:4 x.yar"]);
    expect(at('(include "x.yar")')).toEqual(["1:2 x.yar"]);
  });

  it("ignores include inside comments, strings and regexes", () => {
    expect(
      at(
        [
          '// include "a.yar"',
          '/* include "b.yar"',
          ' * include "c.yar" */',
          '$s = "include \\"d.yar\\""',
          '$r = /include "e.yar"/',
          '$r2 = /a\\/include "f.yar"/is',
          '$h = { 4D 5A /* include "g.yar" */ }',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("requires include to start a token", () => {
    expect(at('xinclude "a.yar"')).toEqual([]);
    expect(at('include_x "a.yar"')).toEqual([]);
    expect(at('$include "a.yar"')).toEqual([]);
    expect(at('#include "a.yar"')).toEqual([]);
    expect(at('@include "a.yar"')).toEqual([]);
    expect(at('!include "a.yar"')).toEqual([]);
    // `0x` with no hex digit is the number 0, then the identifier xinclude.
    expect(at('0xinclude "a.yar"')).toEqual([]);
    expect(at('0oinclude "a.yar"')).toEqual([]);
    // `5M` is 5 then the identifier Minclude.
    expect(at('5Minclude "a.yar"')).toEqual([]);
  });

  it("finds include right after a number token ends", () => {
    expect(at('0xABinclude "a.yar"')).toEqual(["1:5 a.yar"]);
    expect(at('0o17include "a.yar"')).toEqual(["1:5 a.yar"]);
    expect(at('5MBinclude "a.yar"')).toEqual(["1:4 a.yar"]);
    expect(at('5include "a.yar"')).toEqual(["1:2 a.yar"]);
    expect(at('1.5include "a.yar"')).toEqual(["1:4 a.yar"]);
  });

  it("consumes regex flags before a following token", () => {
    // `/x/i` then the identifier nclude.
    expect(at('/x/include "a.yar"')).toEqual([]);
    // `/x/is` then the directive: both flags end the regex token.
    expect(at('/x/isinclude "a.yar"')).toEqual(["1:6 a.yar"]);
    expect(at('/x/ include "a.yar"')).toEqual(["1:5 a.yar"]);
  });

  it("needs horizontal space then a quote", () => {
    expect(at('include\n"a.yar"')).toEqual([]);
    expect(at("include a.yar")).toEqual([]);
    expect(at('include"a.yar"')).toEqual([]);
  });

  it("resumes after a line break that yara rejects inside a string or regex", () => {
    expect(at('"open\ninclude "a.yar"')).toEqual(["2:1 a.yar"]);
    expect(at('/open\ninclude "a.yar"')).toEqual(["2:1 a.yar"]);
  });

  it("reports an unterminated path, a path that is not UTF-8, and a long path as null", () => {
    expect(at('include "never-closed')).toEqual(["1:1 null"]);
    expect(
      scan(
        Buffer.concat([
          Buffer.from('include "'),
          Buffer.from([0xff, 0xfe]),
          Buffer.from('"'),
        ]),
      ).directives,
    ).toEqual([{ line: 1, column: 1, path: null }]);
    const long = "a".repeat(MAX_RETAINED_PATH_BYTES + 1);
    expect(at(`include "${long}"`)).toEqual(["1:1 null"]);
  });

  it("counts every directive and retains a bounded list", () => {
    const text = Array.from(
      { length: MAX_RETAINED_DIRECTIVES + 3 },
      (_, index) => `include "r${String(index)}.yar"`,
    ).join("\n");
    const result = scan(text);
    expect(result.total).toBe(MAX_RETAINED_DIRECTIVES + 3);
    expect(result.directives).toHaveLength(MAX_RETAINED_DIRECTIVES);
  });

  it("gives the same result however the bytes are chunked", () => {
    const text = [
      '/* include "a.yar" */ include "b.yar"',
      'rule R { strings: $s = "x\\"include \\"" condition: 0xABinclude "c.yar" }',
      '/r\\/x/i include\t"d.yar"',
    ].join("\n");
    expect(scanBytewise(text)).toEqual(scan(text));
    expect(scan(text).total).toBe(3);
  });

  // Independent of this scanner: each case's `opened` list is what libyara
  // 4.5.4 itself asked to open (see the fixture). A wrong lexer assumption
  // here would let an include through or refuse a valid rule.
  it.each(YARA_INCLUDE_LEXER_CASES)(
    "opens exactly what libyara opens: $name",
    ({ text, opened }) => {
      expect(scan(text).directives.map(({ path }) => path)).toEqual(opened);
    },
  );
});
