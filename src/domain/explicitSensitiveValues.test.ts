import { expect, it } from "vitest";
import {
  explicitUtf8Spellings,
  explicitValuesOccurIn,
  isTransportCredentialHeader,
  redactExplicitOutput,
  redactExplicitText,
} from "./explicitSensitiveValues.js";

it.each([
  ["secret context", ["secret"], "[REDACTED] context"],
  ["secret context", ["secret", "REDACTED"], "… context"],
  ["secret context", ["secret", "[", "…"], " context"],
  [
    "secretable context",
    ["secret", "able", "table"],
    "[REDACTED][REDACTED] context",
  ],
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
