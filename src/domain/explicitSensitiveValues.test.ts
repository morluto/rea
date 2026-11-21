import { expect, it } from "vitest";
import {
  explicitTextSpellings,
  explicitUtf16Spellings,
  explicitUtf8Spellings,
  explicitValueSpans,
  lowercasePercentEscapes,
  explicitValuesOccurIn,
  isTransportCredentialHeader,
  redactExplicitOutput,
  redactExplicitText,
} from "./explicitSensitiveValues.js";

it.each([
  ["secret context", ["secret"], "[REDACTED] context"],
  ["secret context", ["secret", "REDACTED"], "… context"],
  ["secret context", ["secret", "[", "…"], " context"],
  // Overlapping declarations redact as one span, leaving no fragment between.
  ["secretable context", ["secret", "able", "table"], "[REDACTED] context"],
  ["secretsecret context", ["secret", "…", "REDACTED"], " context"],
] as const)(
  "keeps declared literals out of replacement text: %s",
  (input, values, expected) => {
    const result = redactExplicitText(input, values);
    expect(result).toBe(expected);
    for (const value of values) expect(result).not.toContain(value);
  },
);

it("does not guess sensitivity or treat empty declarations as matches", () => {
  expect(redactExplicitText("API_SECRET ordinary evidence", [""])).toBe(
    "API_SECRET ordinary evidence",
  );
  expect(explicitValuesOccurIn("API_SECRET ordinary evidence", [""])).toBe(
    false,
  );
});

it("uses a caller's marker unless it would spell a declaration", () => {
  expect(
    redactExplicitText("token=abc", ["abc"], {
      replacement: "[control token]",
    }),
  ).toBe("token=[control token]");
  expect(
    redactExplicitText("token=con", ["con"], {
      replacement: "[control token]",
    }),
  ).toBe("token=[REDACTED]");
});

it.each([
  [
    "complete output keeps an unrelated tail",
    false,
    "log private",
    "log private",
  ],
  [
    "cut output replaces a declared prefix",
    true,
    "log private-tr",
    "log [REDACTED]",
  ],
  [
    "cut output replaces whole values before the tail",
    true,
    "private-transport-token then private-",
    "[REDACTED] then [REDACTED]",
  ],
  [
    "cut output without a declared prefix is unchanged",
    true,
    "log done",
    "log done",
  ],
] as const)("%s", (_name, cutOff, text, expected) => {
  expect(
    redactExplicitText(text, ["private-transport-token"], { cutOff }),
  ).toBe(expected);
});

it("treats output as cut when more bytes were observed than retained", () => {
  const token = "private-transport-token";
  expect(
    redactExplicitOutput(
      { text: token.slice(0, 8), bytes: 8, observedBytes: token.length },
      [token],
    ),
  ).toBe("[REDACTED]");
  expect(
    redactExplicitOutput({ text: "priv", bytes: 4, observedBytes: 4 }, [token]),
  ).toBe("priv");
});

it("spells declarations in UTF-8 and skips values with no UTF-8 form", () => {
  expect(explicitUtf8Spellings(["é", "\ud800", "", "é"])).toEqual([
    Buffer.from("é", "utf8"),
  ]);
});

it("recognizes protocol-defined credential headers in any case only", () => {
  for (const name of [
    "Authorization",
    "proxy-authorization",
    "Cookie",
    "SET-COOKIE",
  ])
    expect(isTransportCredentialHeader(name)).toBe(true);
  for (const name of ["x-api-key", "x-auth-token", "location"])
    expect(isTransportCredentialHeader(name)).toBe(false);
});

it("merges overlapping occurrences of one or several declarations", () => {
  expect([...explicitValueSpans("aaaa", ["aa"])]).toEqual([
    { start: 0, end: 4 },
  ]);
  expect([
    ...explicitValueSpans("abcdef xx cd", ["abcd", "cdef", "cd"]),
  ]).toEqual([
    { start: 0, end: 6 },
    { start: 10, end: 12 },
  ]);
  expect([...explicitValueSpans("abab", ["ab"])]).toEqual([
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  expect([...explicitValueSpans("text", [""])]).toEqual([]);
});

it("spells a declared value in each selected encoding", () => {
  expect(
    explicitTextSpellings("a b'/é", [
      "uri-component",
      "uri-query",
      "uri-plus-space",
      "form",
    ]),
  ).toEqual([
    "a%20b'%2F%C3%A9",
    "a%20b%27%2F%C3%A9",
    "a+b'%2F%C3%A9",
    "a+b%27%2F%C3%A9",
  ]);
  expect(explicitTextSpellings('q"\\n', ["json-escaped"])).toEqual([
    'q\\"\\\\n',
  ]);
  expect(explicitTextSpellings("ok", ["json-escaped"])).toEqual([]);
  expect(explicitTextSpellings("\u00ff", ["hex"])).toEqual(["c3bf", "C3BF"]);
  const base64 = explicitTextSpellings("secret-value", ["base64"]);
  for (const prefix of ["", "x", "xy"])
    expect(
      base64.some((spelling) =>
        Buffer.from(`${prefix}secret-value`)
          .toString("base64")
          .includes(spelling),
      ),
    ).toBe(true);
  // URL serializers write an unpaired surrogate as U+FFFD.
  expect(explicitTextSpellings("\ud800", ["uri-component"])).toEqual([
    "%EF%BF%BD",
  ]);
  expect(explicitUtf16Spellings("ab")).toEqual([
    Buffer.from([0x61, 0, 0x62, 0]),
    Buffer.from([0, 0x61, 0, 0x62]),
  ]);
  expect(lowercasePercentEscapes("a%2Fb%C3")).toBe("a%2fb%c3");
});

it("finds spans lazily, so a budgeted caller stops matching early", () => {
  const spans = explicitValueSpans("token ".repeat(100_000), ["token"]);
  expect(spans.next().value).toEqual({ start: 0, end: 5 });
  expect(spans.next().value).toEqual({ start: 6, end: 11 });
});

it("redacts the declared literal with [REDACTED] and preserves surrounding text", () => {
  expect(redactExplicitText("my secret here", ["secret"])).toBe(
    "my [REDACTED] here",
  );
});

it("falls back to … when [REDACTED] would contain a declared literal", () => {
  expect(redactExplicitText("a RED b", ["RED"])).toBe("a … b");
});

it("falls back to empty replacement when both [REDACTED] and … contain a literal", () => {
  expect(redactExplicitText("xEy…z", ["E", "…"])).toBe("xyz");
});

it("fails closed to empty output when redaction re-forms a declared literal", () => {
  expect(redactExplicitText("seDcret", ["secret", "D", "…"])).toBe("");
});

it("replaces the longest declared literal first so overlaps resolve correctly", () => {
  expect(redactExplicitText("xtablex", ["able", "table"])).toBe("x[REDACTED]x");
});
