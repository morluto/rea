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

it("appends a target to itself only once", () => {
  const values = [1, 2];
  let yielded = 0;
  Object.defineProperty(values, Symbol.iterator, {
    value: function* () {
      for (const value of Array.prototype.values.call(
        this,
      ) as Iterable<number>) {
        if (++yielded > 2) throw new Error("reread appended item");
        yield value;
      }
    },
  });

  expect(appendAll(values, values)).toBe(values);
  expect(values.slice()).toEqual([1, 2, 1, 2]);
  expect(yielded).toBe(2);
});
