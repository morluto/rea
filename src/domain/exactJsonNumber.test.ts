import { expect, it } from "vitest";

import { parseExactJson } from "./exactJsonNumber.js";

it("retains numeric identity when serializing and reparsing exact JSON", () => {
  for (const [spelling, expected] of [
    ["1e-7", 1e-7],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
    ["1e21", 1e21],
    ["1.000e21", 1e21],
    ["1.7976931348623157e308", Number.MAX_VALUE],
  ] as const) {
    const parsed = parseExactJson(`{"id":${spelling}}`);
    expect(parsed, spelling).toEqual({ id: expected });
    expect(parseExactJson(JSON.stringify(parsed))).toEqual({ id: expected });
  }

  for (const spelling of [
    "9007199254740992",
    "9.007199254740992e15",
    "1e20",
    "100000000000000000000",
    "1000000000000000000000",
    "1.00000000000000000001e21",
    "-0",
  ]) {
    expect(parseExactJson(`{"id":${spelling}}`), spelling).toBeUndefined();
  }
});
