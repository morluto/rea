import { expect, it } from "vitest";

import { projectPlistValue } from "./plistValue.js";

it("projects plist data, dates, and non-finite reals as typed values", () => {
  expect(
    projectPlistValue({
      blob: new Uint8Array([0, 1, 2]),
      when: new Date("2020-01-01T00:00:00Z"),
      nested: [{ ratio: 0.5, missing: Number.NaN, unbounded: -Infinity }],
      plain: { "": "empty key", flag: true, count: 42 },
    }),
  ).toEqual({
    value: {
      blob: { $plist_type: "data", base64: "AAEC" },
      when: { $plist_type: "date", iso8601: "2020-01-01T00:00:00.000Z" },
      nested: [
        {
          ratio: 0.5,
          missing: { $plist_type: "real", value: null },
          unbounded: { $plist_type: "real", value: null },
        },
      ],
      plain: { "": "empty key", flag: true, count: 42 },
    },
    unknownRealCount: 2,
  });
});

it("rejects values a plist decoder cannot produce", () => {
  expect(() => projectPlistValue({ value: Symbol("x") })).toThrow();
  const deep: unknown[] = [];
  let cursor = deep;
  for (let depth = 0; depth < 200; depth += 1) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  expect(() => projectPlistValue(deep)).toThrow(RangeError);
});
