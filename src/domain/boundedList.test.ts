import { expect, it } from "vitest";

import { BoundedListCollector, boundedList } from "./boundedList.js";

it("retains up to the maximum and counts every item past it", () => {
  expect(boundedList([1, 2], 3)).toEqual({ items: [1, 2], omitted: 0 });
  expect(boundedList([1, 2, 3, 4, 5], 3)).toEqual({
    items: [1, 2, 3],
    omitted: 2,
  });
  // Re-bounding a list keeps the count an earlier bound recorded.
  expect(boundedList([0, 1, 2, 3], 3, 2)).toEqual({
    items: [0, 1, 2],
    omitted: 3,
  });
});

it("collects up to the maximum and counts later pushes", () => {
  const collector = new BoundedListCollector<string>(2);
  for (const item of ["a", "b", "c", "d"]) collector.push(item);
  expect(collector.retains("a")).toBe(true);
  expect(collector.retains("c")).toBe(false);
  expect(collector.toList()).toEqual({ items: ["a", "b"], omitted: 2 });
});
