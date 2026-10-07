import { describe, expect, it } from "vitest";
import { javascriptRecoveryInputSchema } from "./javascriptRecovery.js";

describe("JavaScript recovery requests", () => {
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
