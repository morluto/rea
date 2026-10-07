import { describe, expect, it } from "vitest";
import { javascriptRecoveryInputSchema } from "./javascriptRecovery.js";

describe("JavaScript recovery requests", () => {
  it("defaults omitted transform metadata without requiring engine confirmations", () => {
    expect(
      javascriptRecoveryInputSchema.parse({
        path: "/tmp/bundle.js",
        output_directory: "/tmp/recovered",
      }),
    ).toEqual({
      path: "/tmp/bundle.js",
      output_directory: "/tmp/recovered",
      extraction_mode: "structural",
      rewrite_level: "standard",
    });
  });
  it.each([
    { path: "", output_directory: "/tmp/recovered" },
    { path: "/tmp/bundle.js" },
    {
      path: "/tmp/bundle.js",
      output_directory: "/tmp/recovered",
      approve: true,
    },
    {
      path: "/tmp/bundle.js",
      output_directory: "/tmp/recovered",
      extraction_mode: "invented",
    },
  ])("rejects malformed input %j", (input) => {
    expect(javascriptRecoveryInputSchema.safeParse(input).success).toBe(false);
  });
});
