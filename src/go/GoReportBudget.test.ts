import { expect, it, vi } from "vitest";
import { parseGoModuleBytes } from "./GoModuleText.js";
import { GoReportLimitFailure } from "./GoReportBudget.js";

it.each([
  "path\tp\nmod\tm\tv\ts\n=>\tr\tv\ts\ndep\td\tv\ts\n=>\tr\tv\ts\nbuild\tk=v\n",
  "unknown\nunterminated",
  "\n\n",
])(
  "charges the exact encoded module representation, including replacements and unknowns",
  (text) => {
    const source = Buffer.from(text);
    const expected = parseGoModuleBytes(source);
    const exact = Buffer.byteLength(JSON.stringify(expected));
    expect(parseGoModuleBytes(source, exact)).toEqual(expected);
    expect(() => parseGoModuleBytes(source, exact - 1)).toThrow(
      GoReportLimitFailure,
    );
  },
);

it("charges raw non-UTF8 lines before base64 allocation", () => {
  const source = Buffer.from([0xff, 10, 0xff, 0xff, 10]);
  const expected = parseGoModuleBytes(source);
  const exact = Buffer.byteLength(JSON.stringify(expected));
  expect(parseGoModuleBytes(source, exact)).toEqual(expected);
  expect(() => parseGoModuleBytes(source, exact - 1)).toThrow(
    GoReportLimitFailure,
  );
});

it("stops retaining dense records and escaped strings at a finite representation budget", () => {
  for (const source of [
    Buffer.from("dep\tp\tv\n".repeat(10000)),
    Buffer.alloc(10000, 1),
  ])
    expect(() => parseGoModuleBytes(source, 4096)).toThrow(
      GoReportLimitFailure,
    );
});

it.each([
  { kind: "dependencies", source: Buffer.from("dep\tp\tv\n".repeat(10000)) },
  {
    kind: "non-UTF8 lines",
    source: Buffer.from("\xff\n".repeat(10000), "latin1"),
  },
])(
  "stops examining later $kind when the decoded representation is full",
  ({ source }) => {
    const examined = vi.spyOn(source, "indexOf");
    try {
      expect(() => parseGoModuleBytes(source, 4096)).toThrow(
        GoReportLimitFailure,
      );
      // A post-parse size check would examine all 10,000 lines first.
      expect(examined.mock.calls.length).toBeGreaterThan(0);
      expect(examined.mock.calls.length).toBeLessThan(10000);
    } finally {
      examined.mockRestore();
    }
  },
);
