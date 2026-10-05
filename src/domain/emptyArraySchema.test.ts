import { describe, expect, it } from "vitest";

import { emptyArraySchema } from "./emptyArraySchema.js";

describe("empty array schema", () => {
  it("accepts only an empty array", () => {
    expect(emptyArraySchema.parse([])).toEqual([]);
    for (const value of [
      [null],
      ["candidate"],
      [0],
      [false],
      [{}],
      [[]],
      null,
      {},
    ]) {
      expect(emptyArraySchema.safeParse(value).success).toBe(false);
    }
  });
});
