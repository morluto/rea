import { describe, expect, it } from "vitest";

import {
  parseYaraDiagnostics,
  parseYaraMeta,
  YaraMatchOutputParser,
} from "./YaraOutput.js";

const SCANNED = "/work/sample [1].bin";

const parse = (text: string | Buffer, maxListed = 100, chunk = 0) => {
  const parser = new YaraMatchOutputParser(SCANNED, maxListed);
  const bytes = typeof text === "string" ? Buffer.from(text, "latin1") : text;
  if (chunk === 0) parser.push(bytes);
  else
    for (let offset = 0; offset < bytes.length; offset += chunk)
      parser.push(bytes.subarray(offset, offset + chunk));
  return parser.finish();
};

// Recorded from yara 4.6.0 `-s -L -m -g -q` on a synthetic sample.
const RECORDED = [
  `Hello [tagA,tagB] [author="A \\"q\\" \\\\ b, c] [d",score =42,neg =-7,ok=true,nope=false,uni="caf\\303\\251"] ${SCANNED}`,
  "0x4:5:$t: hello",
  "0x36:5:$t: hello",
  "0x0:4:$h: 4D 5A 90 00",
  '0x12:26:$x: secret_KEY "quoted" \\back\\x0A',
  "0x31:10:$r: tail hello",
  `NoTagsNoMeta [] [] ${SCANNED}`,
  "0x2c:4:$a: AAAA",
  `Cond [] [] ${SCANNED}`,
  "",
].join("\n");

describe("YaraMatchOutputParser", () => {
  it("reads rules, tags, typed meta and string matches", () => {
    const parsed = parse(RECORDED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.stringMatches).toBe(6);
    expect(parsed.value.listedStringMatches).toBe(6);
    expect(parsed.value.matches).toEqual([
      {
        rule: "Hello",
        tags: ["tagA", "tagB"],
        meta: [
          { identifier: "author", type: "string", value: 'A "q" \\ b, c] [d' },
          { identifier: "score", type: "integer", value: 42 },
          { identifier: "neg", type: "integer", value: -7 },
          { identifier: "ok", type: "boolean", value: true },
          { identifier: "nope", type: "boolean", value: false },
          { identifier: "uni", type: "string", value: "café" },
        ],
        string_match_count: 5,
        strings: [
          { identifier: "$t", file_offset: 4, length: 5, data: "hello" },
          { identifier: "$t", file_offset: 0x36, length: 5, data: "hello" },
          {
            identifier: "$h",
            file_offset: 0,
            length: 4,
            data: "4D 5A 90 00",
          },
          {
            identifier: "$x",
            file_offset: 0x12,
            length: 26,
            data: 'secret_KEY "quoted" \\back\\x0A',
          },
          {
            identifier: "$r",
            file_offset: 0x31,
            length: 10,
            data: "tail hello",
          },
        ],
      },
      {
        rule: "NoTagsNoMeta",
        tags: [],
        meta: [],
        string_match_count: 1,
        strings: [
          { identifier: "$a", file_offset: 0x2c, length: 4, data: "AAAA" },
        ],
      },
      { rule: "Cond", tags: [], meta: [], string_match_count: 0, strings: [] },
    ]);
  });

  it("parses identically when stdout arrives one byte at a time", () => {
    expect(parse(RECORDED, 100, 1)).toEqual(parse(RECORDED));
  });

  it("accepts CRLF line ends", () => {
    expect(parse(RECORDED.replaceAll("\n", "\r\n"))).toEqual(parse(RECORDED));
  });

  it("counts matches beyond the listing budget without retaining them", () => {
    const parsed = parse(RECORDED, 2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.stringMatches).toBe(6);
    expect(parsed.value.listedStringMatches).toBe(2);
    expect(parsed.value.matches.map((match) => match.strings.length)).toEqual([
      2, 0, 0,
    ]);
    expect(
      parsed.value.matches.map((match) => match.string_match_count),
    ).toEqual([5, 1, 0]);
  });

  it("reports empty output as no matches", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: { matches: [], stringMatches: 0, listedStringMatches: 0 },
    });
  });

  it("refuses output that ends inside a line", () => {
    expect(parse(RECORDED.slice(0, -1))).toEqual({
      ok: false,
      error: { line: 9, reason: "stdout ended inside a line" },
    });
  });

  it("refuses a rule line for another file", () => {
    expect(parse("Other [] [] /work/other.bin\n")).toEqual({
      ok: false,
      error: { line: 1, reason: "rule line does not name the scanned file" },
    });
  });

  it("refuses a string line before any rule", () => {
    expect(parse("0x0:1:$a: A\n")).toEqual({
      ok: false,
      error: { line: 1, reason: "string match line before any rule line" },
    });
  });

  it("refuses malformed string lines", () => {
    const parsed = parse(`R [] [] ${SCANNED}\n0xZZ:1:$a: A\n`);
    expect(parsed).toEqual({
      ok: false,
      error: { line: 2, reason: "malformed string match line" },
    });
  });

  it("refuses offsets beyond the safe integer range", () => {
    const parsed = parse(`R [] [] ${SCANNED}\n0x20000000000000:1:$a: A\n`);
    expect(parsed).toEqual({
      ok: false,
      error: {
        line: 2,
        reason: "string match offset or length exceeds the safe range",
      },
    });
  });

  it("keeps a matched data field that itself contains a line prefix", () => {
    const parsed = parse(`R [] [] ${SCANNED}\n0x0:6:$a: 0x0:1:\n`);
    expect(parsed.ok && parsed.value.matches[0]?.strings[0]?.data).toBe(
      "0x0:1:",
    );
  });
});

describe("parseYaraMeta", () => {
  it("decodes escapes and octal bytes", () => {
    expect(parseYaraMeta('a="x\\ny\\tz\\r\\101"')).toEqual([
      { identifier: "a", type: "string", value: "x\ny\tz\rA" },
    ]);
  });

  it("decodes every escape yara's print_escaped_data writes", () => {
    // Quote, apostrophe and backslash are backslash-escaped; 0x07..0x0d use
    // C escapes; other control and high bytes are three-digit octal.
    expect(
      parseYaraMeta(String.raw`a="it\'s \"q\" \\ \a\b\t\n\v\f\r\033\177"`),
    ).toEqual([
      {
        identifier: "a",
        type: "string",
        value: 'it\'s "q" \\ \x07\x08\t\n\x0b\x0c\r\x1b\x7f',
      },
    ]);
  });

  it("refuses an octal escape yara does not write", () => {
    expect(parseYaraMeta(String.raw`a="\1"`)).toBe(
      "unknown escape \\1 in a meta string",
    );
    expect(parseYaraMeta(String.raw`a="\400"`)).toBe(
      "unknown escape \\4 in a meta string",
    );
  });

  it("keeps non UTF-8 strings as hex bytes", () => {
    expect(parseYaraMeta('a="\\377\\376"')).toEqual([
      { identifier: "a", type: "bytes", value: "fffe" },
    ]);
  });

  it("keeps integers beyond the safe range as decimal text", () => {
    expect(parseYaraMeta("big =9223372036854775807")).toEqual([
      { identifier: "big", type: "integer", value: "9223372036854775807" },
    ]);
  });

  it("returns a reason for malformed entries", () => {
    expect(parseYaraMeta('a="open')).toBe("unterminated meta string");
    expect(parseYaraMeta("a=maybe")).toBe('invalid meta value "maybe"');
    expect(parseYaraMeta('a="\\q"')).toBe(
      "unknown escape \\q in a meta string",
    );
    expect(parseYaraMeta("noValue")).toBe("meta entry without a value");
  });
});

describe("parseYaraDiagnostics", () => {
  it("classifies recorded yara stderr forms", () => {
    expect(
      parseYaraDiagnostics(
        [
          'warning: rule "Slow" in /r/m.yar(2): string "$a" may slow down scanning',
          "/r/m.yar(4): warning: rule-less warning",
          'error: rule "Bad" in /r/bad.yar(1): undefined identifier "nope"',
          '/r/a2.yar(1): error: duplicated identifier "A"',
          "/rules/main.yar(1): error: can't open include file: /rules/common.yar",
          "/r/s.yar(7): error: syntax error, unexpected <end of file>",
          '/r/u.yar(2): error: unknown module "nope"',
          "/r/c.yar(3): error: include circular reference",
          'error: rule "R" in /r/o.yar(5): "pe" is not a structure',
          "error: could not open file: /r/missing.yar",
          `error scanning ${SCANNED}: could not open file`,
          "something else",
          "",
        ].join("\n"),
        SCANNED,
      ),
    ).toEqual({
      warnings: [
        'warning: rule "Slow" in /r/m.yar(2): string "$a" may slow down scanning',
        "/r/m.yar(4): warning: rule-less warning",
      ],
      compileErrors: [
        {
          kind: "undefined",
          source: "/r/bad.yar",
          line: 1,
          rule: "Bad",
          message: 'undefined identifier "nope"',
        },
        {
          kind: "duplicate",
          source: "/r/a2.yar",
          line: 1,
          rule: null,
          message: 'duplicated identifier "A"',
        },
        {
          kind: "other",
          source: "/rules/main.yar",
          line: 1,
          rule: null,
          message: "can't open include file: /rules/common.yar",
        },
        {
          kind: "syntax",
          source: "/r/s.yar",
          line: 7,
          rule: null,
          message: "syntax error, unexpected <end of file>",
        },
        {
          kind: "undefined",
          source: "/r/u.yar",
          line: 2,
          rule: null,
          message: 'unknown module "nope"',
        },
        {
          kind: "other",
          source: "/r/c.yar",
          line: 3,
          rule: null,
          message: "include circular reference",
        },
        {
          kind: "other",
          source: "/r/o.yar",
          line: 5,
          rule: "R",
          message: '"pe" is not a structure',
        },
        {
          kind: "unreadable_file",
          source: "/r/missing.yar",
          line: null,
          rule: null,
          message: "could not open file",
        },
      ],
      scanErrors: [{ path: SCANNED, reason: "could not open file" }],
      unrecognized: ["something else"],
    });
  });

  it("matches a FILE yara was given exactly and splits any other FILE only where one complete diagnostic remains", () => {
    const odd = "/r/odd(2): x.yar";
    expect(
      parseYaraDiagnostics(
        [
          `${odd}(4): error: syntax error, unexpected "(9): error: "`,
          '/inc/a.yar(3): error: undefined identifier "b(1): c"',
          `error: rule "S" in ${odd}(6): undefined string "$x"`,
          // A file yara names that was not given, whose name contains "(N): ".
          "/rules/odd(2): x.yar(4): error: syntax error",
          // Two splits each leave a complete diagnostic: the location is unknown.
          'error: rule "T" in /rules/odd(2): x.yar(7): undefined identifier "q"',
          "/a(1): error: b.yar(2): error: syntax error",
        ].join("\n"),
        SCANNED,
        [odd],
      ),
    ).toEqual({
      warnings: [],
      compileErrors: [
        {
          kind: "syntax",
          source: odd,
          line: 4,
          rule: null,
          message: 'syntax error, unexpected "(9): error: "',
        },
        {
          kind: "undefined",
          source: "/inc/a.yar",
          line: 3,
          rule: null,
          message: 'undefined identifier "b(1): c"',
        },
        {
          kind: "undefined",
          source: odd,
          line: 6,
          rule: "S",
          message: 'undefined string "$x"',
        },
        {
          kind: "syntax",
          source: "/rules/odd(2): x.yar",
          line: 4,
          rule: null,
          message: "syntax error",
        },
        {
          kind: "other",
          source: null,
          line: null,
          rule: "T",
          message: '/rules/odd(2): x.yar(7): undefined identifier "q"',
        },
        {
          kind: "other",
          source: null,
          line: null,
          rule: null,
          message: "/a(1): error: b.yar(2): error: syntax error",
        },
      ],
      scanErrors: [],
      unrecognized: [],
    });
  });
});
