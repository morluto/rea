import { expect, it } from "vitest";

import { appendAll } from "./arrayAppend.js";

it("appends in order like a spread, including an array appended to itself", () => {
  const target = ["a", "b"];
  appendAll(target, ["c", "d"]);
  expect(target).toEqual(["a", "b", "c", "d"]);
  appendAll(target, target);
  expect(target).toEqual(["a", "b", "c", "d", "a", "b", "c", "d"]);
});
