import { describe, expect, it } from "vitest";

import { readComparisonResult } from "./comparisonEvidenceResult.js";
import type { Evidence } from "./evidence.js";

const source = `ev_${"a".repeat(64)}`;
const hash = "b".repeat(64);
const other = "c".repeat(64);

const evidence = (result: Record<string, unknown>): Evidence =>
  ({
    evidence_id: `ev_${"d".repeat(64)}`,
    evidence_links: [source],
    parameters: {
      left_evidence_id: source,
      right_evidence_id: source,
    },
    normalized_result: result,
  }) as unknown as Evidence;

const dimension = (
  status: "changed" | "unchanged",
  left: string,
  right: string,
) => ({
  dimension: "identity",
  left_count: 1,
  right_count: 1,
  evidence_links: [source, source],
  limitations: [],
  status,
  left_digest: left,
  right_digest: right,
  text_delta: null,
  conclusion_kind: "derived_relationship",
});

describe("same-evidence comparison admission", () => {
  it("rejects a changed dimension for one source", () => {
    const parsed = readComparisonResult(
      evidence({
        status: "changed",
        function_match: {
          status: "matched",
          method: "same-evidence",
          left_name: "main",
          right_name: "main",
        },
        left_subject_sha256: hash,
        right_subject_sha256: hash,
        summary: { unchanged: 0, changed: 1, unknown: 0 },
        dimensions: [dimension("changed", hash, other)],
      }),
      "compare_functions",
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects unequal subject hashes and unequal unchanged digests", () => {
    const parsed = readComparisonResult(
      evidence({
        status: "unchanged",
        function_match: {
          status: "matched",
          method: "same-evidence",
          left_name: "main",
          right_name: "main",
        },
        left_subject_sha256: hash,
        right_subject_sha256: other,
        summary: { unchanged: 1, changed: 0, unknown: 0 },
        dimensions: [dimension("unchanged", hash, other)],
      }),
      "compare_functions",
    );
    expect(parsed.ok).toBe(false);
  });
});
