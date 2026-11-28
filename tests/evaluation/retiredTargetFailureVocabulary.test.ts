import { expect, it } from "vitest";
import { usesRetiredTargetFailureVocabulary } from "../../scripts/verify/retired-target-failure-vocabulary.mjs";

it.each([
  [
    "the unsupported-target error class",
    "throw new AnalysisUnsupportedTargetError(op, path);",
  ],
  [
    "the malformed-target error class",
    "instanceof AnalysisMalformedTargetError",
  ],
  ["the Mach-O issue struct", "type T = MachoReadIssue | null;"],
  ["the FAT range issue struct", "const r: FatSliceRangeIssue = x;"],
  ["the retired detail field", "details.format_failure"],
  ["a TypeScript format reason", '{ reason: "format", detail }'],
  ["a format reason comparison", 'if (failure.reason === "format") {}'],
  ["a format reason on a worker wire", '{"reason": "format", "detail": "x"}'],
  [
    "a Python bridge format failure",
    'raise LayoutFailure("format", "bad header")',
  ],
  [
    "the old ESP failure declaration",
    'readonly kind: "format" | "unsupported";',
  ],
  ["a format kind after a model kind", 'type K = "truncated" | "format";'],
])("rejects %s", (_label, source) => {
  expect(usesRetiredTargetFailureVocabulary(source)).toBe(true);
});

it.each([
  ["a desktop draft change kind", 'return { kind: "format" };'],
  ["a field list", 'Pick<ArtifactNode, "format" | "architecture">'],
  ["a CLI option union", 'option: "format" | "filter-output"'],
  ["the model's own fields", '{ kind: "malformed", format: "esp-image" }'],
])("accepts %s", (_label, source) => {
  expect(usesRetiredTargetFailureVocabulary(source)).toBe(false);
});
