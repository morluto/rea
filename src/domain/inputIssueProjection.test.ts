import { describe, expect, it } from "vitest";
import { z } from "zod";

import { artifactExtractionInputSchema } from "../contracts/artifactToolContracts.js";
import { projectInputIssues } from "./inputIssueProjection.js";

describe("input issue projection", () => {
  it("preserves schema-authored custom correction guidance", () => {
    const schema = z
      .object({ left: z.string().optional(), right: z.string().optional() })
      .superRefine((value, context) => {
        if (value.left === undefined && value.right === undefined)
          context.addIssue({
            code: "custom",
            path: [],
            message: "Supply either left or right",
          });
      });
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, {})).toEqual([
      {
        path: [],
        reason: "invalid_value",
        message: "Supply either left or right",
      },
    ]);
  });

  it("rejects relative extraction destinations at the caller boundary", () => {
    expect(
      artifactExtractionInputSchema.safeParse({
        approved: true,
        output_root: "relative/output",
        occurrence_ids: [`occ_${"0".repeat(64)}`],
      }).success,
    ).toBe(false);
  });
});
