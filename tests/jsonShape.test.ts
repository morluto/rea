import { describe, expect, it } from "vitest";

import { inferJsonShape } from "../src/domain/jsonShape.js";

describe("inferJsonShape", () => {
  it("retains paths and types without retaining JSON values", () => {
    const shape = inferJsonShape(
      JSON.stringify({
        token: "super-secret",
        users: [
          { id: 1, active: true },
          { id: "second-secret", active: false },
        ],
        optional: null,
      }),
      { maximumBytes: 4_096, maximumNodes: 100, maximumDepth: 10 },
    );

    expect(shape).toMatchObject({
      root_type: "object",
      truncated: false,
      properties: expect.arrayContaining([
        { path: "/token", types: ["string"], observations: 1 },
        {
          path: "/users/*/id",
          types: ["number", "string"],
          observations: 2,
        },
        {
          path: "/users/*/active",
          types: ["boolean"],
          observations: 2,
        },
      ]),
    });
    expect(JSON.stringify(shape)).not.toContain("super-secret");
    expect(JSON.stringify(shape)).not.toContain("second-secret");
  });

  it("rejects malformed and oversized JSON without returning a prefix", () => {
    const limits = {
      maximumBytes: 8,
      maximumNodes: 100,
      maximumDepth: 10,
    };
    expect(inferJsonShape("not-json", limits)).toBeNull();
    expect(inferJsonShape('{"secret":"value"}', limits)).toBeNull();
  });

  it("reports node and depth truncation deterministically", () => {
    expect(
      inferJsonShape('{"a":{"b":{"c":1}}}', {
        maximumBytes: 1_024,
        maximumNodes: 100,
        maximumDepth: 1,
      }),
    ).toMatchObject({ truncated: true, max_depth_observed: 1 });
    expect(
      inferJsonShape("[1,2,3,4]", {
        maximumBytes: 1_024,
        maximumNodes: 2,
        maximumDepth: 10,
      }),
    ).toMatchObject({ truncated: true, node_count: 2 });
  });
});
