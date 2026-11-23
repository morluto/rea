import { describe, expect, it } from "vitest";
import { literalSubstringPredicate } from "./analysisSearch.js";
import { extractRequiredRegexLiteral } from "./regexLiteralCandidate.js";

const approxPythonCasefold = (value: string): string =>
  value
    .replace(/\u017f/gu, "s")
    .replace(/\u212a/gu, "k")
    .replace(/\u00df/gu, "ss")
    .replace(/\u0130/gu, "i\u0307")
    .toLowerCase();

it("extracts longest contiguous literal segments across valid regex constructs", () => {
  expect(extractRequiredRegexLiteral("hello_world", false)).toBe("hello_world");
  expect(extractRequiredRegexLiteral("^prefix\\d+suffix$", true)).toBe(
    "prefix",
  );
  expect(extractRequiredRegexLiteral("^a+foobaz\\dbaz$", true)).toBe("afoobaz");
  expect(extractRequiredRegexLiteral("(?:foo)bar", true)).toBe("foobar");
  expect(extractRequiredRegexLiteral("(?<name>foo)bar", true)).toBe("foobar");
  expect(extractRequiredRegexLiteral("pre(a|b)longer_post", true)).toBe(
    "longer_post",
  );
  expect(extractRequiredRegexLiteral("pre(optional)?mid", true)).toBe("pre");
  expect(extractRequiredRegexLiteral("pre(abc)+post", true)).toBe("post");
  expect(extractRequiredRegexLiteral("x(abc)+y", true)).toBe("abc");
  expect(extractRequiredRegexLiteral("xa{2,}y", true)).toBe("xaa");
  expect(extractRequiredRegexLiteral("ba{3}c", true)).toBe("baaac");
  expect(extractRequiredRegexLiteral(`^ab{64}c$`, true)).toBe(
    `a${"b".repeat(64)}c`,
  );
  expect(extractRequiredRegexLiteral("^ab{65}c$", true)).toBe(
    `a${"b".repeat(64)}`,
  );
  expect(
    `a${"b".repeat(65)}c`.includes(
      extractRequiredRegexLiteral("^ab{65}c$", true)!,
    ),
  ).toBe(true);
  expect(extractRequiredRegexLiteral("^xa{65}longer_suffix$", true)).toBe(
    `${"a".repeat(64)}longer_suffix`,
  );
  expect(
    extractRequiredRegexLiteral(
      `${"(?:".repeat(6000)}foo_deep${")".repeat(6000)}`,
      true,
    ),
  ).toBe("foo_deep");
  expect(extractRequiredRegexLiteral("fooa?", true)).toBe("foo");
  expect(extractRequiredRegexLiteral("pre\\(x\\)\\/path", true)).toBe(
    "pre(x)/path",
  );
  expect(
    extractRequiredRegexLiteral("\\t\\n\\r\\x41\\u0042\\u{43}", true),
  ).toBe("\t\n\rABC");
  expect(extractRequiredRegexLiteral("pre\\p{Letter}+post_text", false)).toBe(
    "post_text",
  );
  expect(extractRequiredRegexLiteral("(tag)\\1longer", true)).toBe("longer");
  expect(extractRequiredRegexLiteral("(?<k>tag)\\k<k>tail", true)).toBe("tail");
});

it("handles anchors, lookarounds, ES2025 inline modifiers, NUL, and astral characters safely", () => {
  expect(extractRequiredRegexLiteral("foo(?=bar)baz", true)).toBe("foo");
  expect(extractRequiredRegexLiteral("foo(?=bar)bazqux", true)).toBe("bazqux");
  expect(extractRequiredRegexLiteral("foo(?<=bar)longer", true)).toBe("longer");
  expect(extractRequiredRegexLiteral("foo(?!bar)bazqux", true)).toBe("bazqux");
  expect(extractRequiredRegexLiteral("(?i:Foo)BarBaz", true)).toBe("BarBaz");
  expect(extractRequiredRegexLiteral("pre(?-i:FOO)longer", false)).toBe(
    "longer",
  );
  expect(extractRequiredRegexLiteral("ab\\0cdef", true)).toBe("cdef");
  expect(extractRequiredRegexLiteral("ab\\x00cd", true)).toBe("ab");
  expect(extractRequiredRegexLiteral("ab\\u0000cd", true)).toBe("ab");
  expect(extractRequiredRegexLiteral("ab\\u{0}cd", true)).toBe("ab");
  expect(extractRequiredRegexLiteral("中文🧪ok", true)).toBe("中文🧪ok");
  expect(extractRequiredRegexLiteral("pre\\uD83E\\uDDEApost", true)).toBe(
    "pre🧪post",
  );
  expect(extractRequiredRegexLiteral("prefix\\u{1F9EA}?suffix", true)).toBe(
    "prefix",
  );
  expect(extractRequiredRegexLiteral("aβcdef", false)).toBe("cdef");
  expect(extractRequiredRegexLiteral("İstorage", false)).toBe("storage");
});

it("returns undefined for alternations, wildcard-only, empty, or invalid regexes", () => {
  for (const pattern of [
    "",
    "[",
    "foo|bar",
    "a(?:b)|c",
    "^[a-z0-9_]+$",
    ".*",
    "(?i:foo)",
    "ß",
    "(?:foo)?",
    "\\d+\\s+\\w+",
  ]) {
    expect(extractRequiredRegexLiteral(pattern, false)).toBeUndefined();
  }
  expect(extractRequiredRegexLiteral("(?i:foo)", true)).toBeUndefined();
});

it("has zero false negatives against ECMAScript /u and /iu plus downstream fold semantics", () => {
  const patterns = [
    "^warfare/.+/read-write$",
    "a+b(c|d)ef+",
    "pre[\\]\\[x]+suf",
    "foo(?:bar(baz))+end",
    "xa{2,4}y",
    "ba{3}?c",
    "pre(?i:foo)post",
    "pre(?=xy)mid(?<=ab)end",
    "\\uD83E\\uDDEA-item",
    "a\\0b+cdef",
    "kelvin",
    "storage",
    "pre(a|b|c)mid(x)?post",
  ];
  const corpus = [
    "Warfare/Storage/Read-Write",
    "warfare/\u017ftoragE/read-write",
    "\u212aelvin",
    "KELVIN",
    "ß",
    "İstorage",
    "aaabcdEF",
    "pre[]xSUF",
    "fooBarBazBazEnd",
    "prefooPOST",
    "ab🧪-item",
    "xaAAy",
    "baaaac",
    "a\0bbbCDEF",
    "preamidxpost",
    "prexymidabend",
  ];
  for (const pattern of patterns) {
    for (const caseSensitive of [false, true]) {
      const regex = new RegExp(pattern, caseSensitive ? "u" : "iu");
      const literal = extractRequiredRegexLiteral(pattern, caseSensitive);
      const matchesLiteral =
        literal === undefined
          ? undefined
          : literalSubstringPredicate(literal, caseSensitive);
      for (const value of corpus) {
        if (!regex.test(value) || literal === undefined) continue;
        if (caseSensitive) {
          expect(value.includes(literal)).toBe(true);
          expect(matchesLiteral?.(value)).toBe(true);
        } else {
          expect(matchesLiteral?.(value)).toBe(true);
          expect(
            approxPythonCasefold(value).includes(approxPythonCasefold(literal)),
          ).toBe(true);
        }
      }
    }
  }
});
