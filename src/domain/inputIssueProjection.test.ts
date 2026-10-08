import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "./inputIssueProjection.js";
import { processScenarioSchema } from "./process/processScenario.js";

describe("input issue projection", () => {
  it("builds application input errors with projected and semantic issues", () => {
    const schema = z.object({ count: z.number().int() });
    const input = { count: "invalid" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const cause = parsed.error;
    const error = analysisInputErrorFromIssues(
      "inspect_fixture",
      parsed.error.issues,
      input,
      {
        cause,
        additionalIssues: [
          { path: ["count"], reason: "out_of_range", minimum: 0 },
        ],
      },
    );

    expect(error.cause).toBe(cause);
    expect(error.issues).toEqual([
      { path: ["count"], reason: "invalid_type", expected: "number" },
      { path: ["count"], reason: "out_of_range", minimum: 0 },
    ]);
  });

  it("preserves static regex guidance without echoing the rejected value", () => {
    const schema = z.object({
      value: z.string().regex(/^[^\0]*$/u, "Values cannot contain NUL"),
    });
    const input = { value: "private\0value" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, input)).toEqual([
      {
        path: ["value"],
        reason: "invalid_format",
        expected: "regex",
        message: "Values cannot contain NUL",
      },
    ]);
  });

  it("projects reserved process environment key constraints at the key path", () => {
    const input = {
      executable: "/usr/bin/true",
      environment: { REA_PROCESS_RUN_ID: "caller-value" },
    };
    const parsed = processScenarioSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, input)).toEqual([
      {
        path: ["environment", "REA_PROCESS_RUN_ID"],
        reason: "invalid_format",
        expected: "regex",
        message: "REA_PROCESS_RUN_ID is reserved by the process adapter",
      },
    ]);
  });

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

  it("reports union branch issues at the union's path once", () => {
    const schema = z.object({
      seed: z.union([
        z.object({ value: z.string().min(1) }),
        z.object({ value: z.literal(""), match: z.literal("exact") }),
      ]),
    });
    const missing = schema.safeParse({});
    if (missing.success) throw new Error("expected invalid input");
    expect(projectInputIssues(missing.error.issues, {})).toEqual([
      { path: ["seed"], reason: "missing_argument", expected: "object" },
    ]);

    const input = { seed: { value: 1 } };
    const nested = schema.safeParse(input);
    if (nested.success) throw new Error("expected invalid input");
    expect(projectInputIssues(nested.error.issues, input)).toEqual(
      expect.arrayContaining([
        { path: ["seed", "value"], reason: "invalid_type", expected: "string" },
      ]),
    );
  });
});
