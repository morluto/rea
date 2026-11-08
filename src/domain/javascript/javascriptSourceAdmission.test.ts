import { expect, it } from "vitest";
import { semanticSourceBudget } from "./javascriptSourceAnalysis.js";

it("reserves each later root before sharing remaining semantic capacity", () => {
  const initial = 300;
  const first = semanticSourceBudget({
    remaining: initial,
    rootBytes: 80,
    laterRootBytes: 120,
    sourceBytes: 10,
    sourceBytesRemaining: 20,
    laterSources: 1,
  });
  expect(first).toBe(130);
  const second = semanticSourceBudget({
    remaining: initial - first,
    rootBytes: 120,
    laterRootBytes: 0,
    sourceBytes: 10,
    sourceBytesRemaining: 10,
    laterSources: 0,
  });
  expect(second).toBe(170);
});

it("keeps later roots when the remaining capacity has no surplus", () => {
  expect(
    semanticSourceBudget({
      remaining: 150,
      rootBytes: 80,
      laterRootBytes: 120,
      sourceBytes: 0,
      sourceBytesRemaining: 0,
      laterSources: 1,
    }),
  ).toBe(80);
  expect(
    semanticSourceBudget({
      remaining: 260,
      rootBytes: 80,
      laterRootBytes: 120,
      sourceBytes: 0,
      sourceBytesRemaining: 0,
      laterSources: 1,
    }),
  ).toBe(110);
});
