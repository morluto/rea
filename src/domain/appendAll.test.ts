import { expect, it } from "vitest";

import { appendAll } from "./appendAll.js";

it("appends an array wider than any call-argument limit", () => {
  // Where `push(...wide)` overflows depends on the engine's stack; a loop
  // has no such limit.
  const wide = Array.from({ length: 2_000_000 }, (_, index) => index);
  const target = [-1];
  expect(appendAll(target, wide)).toBe(target);
  expect(target).toHaveLength(2_000_001);
  expect(target.at(-1)).toBe(1_999_999);
});

it("appends any iterable in order", () => {
  expect(appendAll(["a"], new Set(["b", "c"]))).toEqual(["a", "b", "c"]);
});
