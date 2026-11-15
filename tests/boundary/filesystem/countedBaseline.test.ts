import { expect, it } from "vitest";

import {
  compareCountedBaseline,
  recordLoweredBaseline,
} from "../../../scripts/verify/counted-baseline.mjs";

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
  expect(compared.lowered).toBe(false);
});

it("leaves an absent baseline unchanged so the guard writes no empty entry", () => {
  for (const shrink of [false, true]) {
    const compared = compareCountedBaseline(new Map(), {}, shrink);
    expect(compared).toEqual({
      grown: [],
      stale: [],
      baseline: {},
      lowered: false,
    });
  }
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
  expect(compared.lowered).toBe(true);
  expect(baseline).toEqual({ "src/a.ts": 2, "src/b.ts": 1, "src/gone.ts": 4 });
});

it("leaves the baseline map unchanged for a key with no baseline", () => {
  for (const shrink of [false, true]) {
    const baselines: Record<string, Record<string, number>> = {
      other: { "src/a.ts": 1 },
    };
    const compared = compareCountedBaseline(
      new Map(),
      baselines["new-key"] ?? {},
      shrink,
    );
    expect(recordLoweredBaseline(baselines, "new-key", compared)).toBe(false);
    expect(baselines).toEqual({ other: { "src/a.ts": 1 } });
  }
});

it("removes a key when shrinking removes its last recorded count", () => {
  const gone = { "src/a.ts": 1 };
  const baselines: Record<string, Record<string, number>> = {
    gone,
    kept: { "src/b.ts": 2 },
  };
  const compared = compareCountedBaseline(new Map(), gone, true);
  expect(recordLoweredBaseline(baselines, "gone", compared)).toBe(true);
  expect(baselines).toEqual({ kept: { "src/b.ts": 2 } });
});
