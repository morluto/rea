import { expect, it } from "vitest";
import { redactExplicitText } from "./explicitSensitiveValues.js";

it.each([
  ["secret context", ["secret"]],
  ["secret context", ["secret", "REDACTED"]],
  ["secret context", ["secret", "[", "…"]],
  ["secretable context", ["secret", "able", "table"]],
  ["secretsecret context", ["secret", "…", "REDACTED"]],
] as const)(
  "keeps declared literals out of replacement text: %s",
  (input, values) => {
    const result = redactExplicitText(input, values);
    for (const value of values) expect(result).not.toContain(value);
  },
);

it("does not guess sensitivity or treat empty declarations as matches", () => {
  expect(redactExplicitText("API_SECRET ordinary evidence", [""])).toBe(
    "API_SECRET ordinary evidence",
  );
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
