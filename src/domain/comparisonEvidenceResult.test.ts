import { describe, expect, it } from "vitest";

import { readComparisonResult } from "./comparisonEvidenceResult.js";
import type { Evidence } from "./evidence.js";
import {
  functionComparisonDimensionNameSchema,
  functionComparisonResultSchema,
} from "./functionComparisonSchemas.js";

const source = `ev_${"a".repeat(64)}`;
const hash = "b".repeat(64);
const other = "c".repeat(64);

const evidence = (result: unknown): Evidence =>
  ({
    evidence_id: `ev_${"d".repeat(64)}`,
    evidence_links: [source],
    parameters: { left_evidence_id: source, right_evidence_id: source },
    normalized_result: result,
  }) as unknown as Evidence;

const baseline = () => ({
  status: "unchanged" as const,
  function_match: {
    status: "matched" as const,
    method: "same-evidence" as const,
    left_name: "main",
    right_name: "main",
  },
  left_subject_sha256: hash,
  right_subject_sha256: hash,
  summary: { unchanged: 8, changed: 0, unknown: 0 },
  dimensions: functionComparisonDimensionNameSchema.options.map(
    (dimension) => ({
      dimension,
      left_count: 1,
      right_count: 1,
      evidence_links: [source, source],
      limitations: [],
      status: "unchanged" as const,
      left_digest: hash,
      right_digest: hash,
      text_delta: null,
      conclusion_kind: "derived_relationship" as const,
    }),
  ),
  changes: [],
  limitations: [],
});

describe("same-evidence comparison admission", () => {
  it("accepts a consistent complete comparison", () => {
    const result = baseline();
    expect(functionComparisonResultSchema.safeParse(result).success).toBe(true);
    expect(readComparisonResult(evidence(result), "compare_functions").ok).toBe(
      true,
    );
  });

  it("rejects a changed dimension for one source", () => {
    const result = baseline();
    const changed = {
      ...result.dimensions[0]!,
      status: "changed" as const,
      right_digest: other,
    };
    const candidate = {
      ...result,
      status: "changed" as const,
      summary: { unchanged: 7, changed: 1, unknown: 0 },
      dimensions: [changed, ...result.dimensions.slice(1)],
      changes: [changed],
    };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it("rejects unequal subject hashes for one source", () => {
    const candidate = { ...baseline(), right_subject_sha256: other };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });

  it("rejects unequal unchanged digests for one source", () => {
    const result = baseline();
    const candidate = {
      ...result,
      dimensions: [
        { ...result.dimensions[0]!, right_digest: other },
        ...result.dimensions.slice(1),
      ],
    };
    expect(functionComparisonResultSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(
      readComparisonResult(evidence(candidate), "compare_functions").ok,
    ).toBe(false);
  });
});
