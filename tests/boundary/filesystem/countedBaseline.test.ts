import { expect, it } from "vitest";

import { compareCountedBaseline } from "../../../scripts/verify/counted-baseline.mjs";

it("rejects a file that gains copies or is missing from the baseline", () => {
  const compared = compareCountedBaseline(
    new Map([
      ["src/a.ts", 3],
      ["src/new.ts", 1],
    ]),
    { "src/a.ts": 2 },
    false,
  );
  expect(compared.grown).toEqual([
    { path: "src/a.ts", count: 3, allowed: 2 },
    { path: "src/new.ts", count: 1, allowed: 0 },
  ]);
});

it("reports removed copies as stale until the baseline is lowered", () => {
  const baseline = { "src/a.ts": 2, "src/gone.ts": 1 };
  const compared = compareCountedBaseline(
    new Map([["src/a.ts", 1]]),
    baseline,
    false,
  );
  expect(compared.grown).toEqual([]);
  expect(compared.stale).toEqual([
    { path: "src/a.ts", count: 1, allowed: 2 },
    { path: "src/gone.ts", count: 0, allowed: 1 },
  ]);
  expect(compared.baseline).toBe(baseline);
});

it("only lowers counts when shrinking, never raising one that grew", () => {
  const baseline = { "src/a.ts": 2, "src/b.ts": 1, "src/gone.ts": 4 };
  const compared = compareCountedBaseline(
    new Map([
      ["src/a.ts", 1],
      ["src/b.ts", 5],
    ]),
    baseline,
    true,
  );
  expect(compared.baseline).toEqual({ "src/a.ts": 1, "src/b.ts": 1 });
  expect(compared.grown).toEqual([{ path: "src/b.ts", count: 5, allowed: 1 }]);
  expect(compared.stale).toEqual([]);
  expect(baseline).toEqual({ "src/a.ts": 2, "src/b.ts": 1, "src/gone.ts": 4 });
});
