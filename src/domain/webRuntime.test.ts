import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  webRuntimeLocationSchema,
  webRuntimeSourceSchema,
} from "./webRuntime.js";

const properties = (schema: z.ZodType) =>
  z
    .object({ properties: z.record(z.string(), z.unknown()) })
    .parse(z.toJSONSchema(schema, { io: "output" })).properties;

describe("web runtime coordinate contract", () => {
  it("advertises zero-based resource-relative CDP lines and UTF-16 columns", () => {
    const location = properties(webRuntimeLocationSchema);
    expect(location.line_number).toMatchObject({
      description: expect.stringContaining(
        "Zero-based line in the resource named by url",
      ),
    });
    expect(location.script_id).toMatchObject({
      description: expect.stringContaining(
        "empty for a position taken from a request initiator",
      ),
    });
    expect(location.column_number).toMatchObject({
      description: expect.stringContaining("Zero-based UTF-16 column"),
    });
    const start = properties(
      webRuntimeSourceSchema.shape.resource_start.unwrap(),
    );
    expect(start.line_number).toMatchObject({
      description: expect.stringContaining(
        "Zero-based line where the script text starts",
      ),
    });
  });
});
