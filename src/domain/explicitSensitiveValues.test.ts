import { expect, it } from "vitest";
import { redactExplicitText } from "./explicitSensitiveValues.js";

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
});
