import { expect, it } from "vitest";
import { localCompletenessEnumCount } from "../../scripts/verify/completeness-enum-guard.mjs";

it("counts inline and chained local completeness enums", () => {
  expect(localCompletenessEnumCount('z.enum(["complete", "partial"])')).toBe(1);
  expect(
    localCompletenessEnumCount(
      'note_coverage: z\n  .enum(["complete", "partial"])\n  .describe("x")',
    ),
  ).toBe(1);
  expect(
    localCompletenessEnumCount('z.enum([\n  "complete",\n  "partial",\n])'),
  ).toBe(1);
});

it("ignores enums without a complete literal", () => {
  expect(localCompletenessEnumCount('z.enum(["partial", "unknown"])')).toBe(0);
  expect(localCompletenessEnumCount('z.enum(["completed"])')).toBe(0);
});

it("does not count a detail level", () => {
  expect(
    localCompletenessEnumCount('detail: z\n  .enum(["complete", "summary"])'),
  ).toBe(0);
  expect(
    localCompletenessEnumCount(
      'z.enum(["complete", "summary", "records", "links"])',
    ),
  ).toBe(0);
});
