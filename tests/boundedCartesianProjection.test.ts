import { describe, expect, it } from "vitest";

import { projectBoundedCartesian } from "../src/domain/boundedCartesianProjection.js";

describe("bounded Cartesian projection", () => {
  it("stops projection work at the output limit", () => {
    const values = Array.from({ length: 10_000 }, (_, index) => index);
    let projections = 0;

    const result = projectBoundedCartesian(values, values, 3, (left, right) => {
      projections += 1;
      return [left, right] as const;
    });

    expect(result).toEqual({
      values: [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
      omitted: 100_000_000 - 3,
    });
    expect(projections).toBe(3);
  });
});
