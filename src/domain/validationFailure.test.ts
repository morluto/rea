import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  boundedValidationFailure,
  describeValidationFailure,
  firstValidationIssue,
} from "./validationFailure.js";

describe("boundedValidationFailure", () => {
  it("preserves exact descriptions and issue facts when within budget", () => {
    const schema = z.object({
      caller_input_paths: z.record(z.string(), z.string()),
    });
    const parsed = schema.safeParse({ caller_input_paths: { app: 123 } });
    if (parsed.success) throw new Error("expected invalid input");

    const bounded = boundedValidationFailure(parsed.error, {
      budgetBytes: 8192,
      within: [],
      descriptionCopies: 2,
    });
    expect(bounded.description).toBe(describeValidationFailure(parsed.error));
    expect(bounded.issuePath).toEqual(firstValidationIssue(parsed.error)?.path);
    expect(bounded.remainingIssueCount).toBe(0);
  });

  it("drops oversized path segments to nearest parent and truncates oversized detail messages", () => {
    const longKey = "k".repeat(80 * 1024);
    const recordSchema = z.object({
      caller_input_paths: z.record(z.string(), z.string()),
    });
    const recordFail = recordSchema.safeParse({
      caller_input_paths: { [longKey]: false },
    });
    if (recordFail.success) throw new Error("expected invalid record input");

    const boundedRecord = boundedValidationFailure(recordFail.error, {
      budgetBytes: 4096,
      within: [],
      descriptionCopies: 2,
    });
    expect(boundedRecord.issuePath).toEqual(["caller_input_paths"]);
    expect(boundedRecord.description).toContain("caller_input_paths");
    expect(boundedRecord.description).toContain("nested path omitted");
    expect(boundedRecord.description).not.toContain(longKey);

    const strictSchema = z.object({
      provider: z.strictObject({ id: z.string() }),
    });
    const strictFail = strictSchema.safeParse({
      provider: { id: "x", [longKey]: false },
    });
    if (strictFail.success) throw new Error("expected strict failure");

    const boundedStrict = boundedValidationFailure(strictFail.error, {
      budgetBytes: 2048,
      within: [],
      descriptionCopies: 2,
    });
    expect(boundedStrict.issuePath).toEqual(["provider"]);
    expect(Buffer.byteLength(boundedStrict.description, "utf8")).toBeLessThan(
      1024,
    );
    expect(boundedStrict.description).not.toContain(longKey);
  });

  it("bounds root oversized path keys and non-Zod errors", () => {
    const longKey = "r".repeat(80 * 1024);
    const rootRecordFail = z
      .record(z.string(), z.string())
      .safeParse({ [longKey]: 42 });
    if (rootRecordFail.success) throw new Error("expected failure");

    const boundedRoot = boundedValidationFailure(rootRecordFail.error, {
      budgetBytes: 1024,
      within: [],
      descriptionCopies: 1,
    });
    expect(boundedRoot.issuePath).toEqual([]);
    expect(boundedRoot.description).toContain("the document root");
    expect(boundedRoot.description).toContain("full path omitted");
    expect(boundedRoot.description).not.toContain(longKey);

    const nonZod = boundedValidationFailure(new Error(longKey), {
      budgetBytes: 512,
      descriptionCopies: 2,
    });
    expect(Buffer.byteLength(nonZod.description, "utf8")).toBeLessThanOrEqual(
      256,
    );
  });
});
