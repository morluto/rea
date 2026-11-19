import { expect, it } from "vitest";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { createEvidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { bundleComparisonExecution } from "./BundleComparisonEvidence.js";

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;
const evidence = (label: string) =>
  createEvidence(unknownTarget("not-observed"), PROVIDER, {
    operation: "observe",
    parameters: { label },
    result: { label },
    confidence: "derived",
    authority: "analyst-inference",
  });

it("returns a missing record pair as a typed input failure", () => {
  const leftRecord = evidence("left");
  const rightRecord = evidence("right");
  const left = createEvidenceBundle([leftRecord]);
  const right = createEvidenceBundle([rightRecord]);
  const failed = bundleComparisonExecution({
    left,
    right,
    recordPairs: [
      {
        left_evidence_id: evidence("missing").evidence_id,
        right_evidence_id: rightRecord.evidence_id,
      },
    ],
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) throw new Error("Expected a failure");
  expect(failed.error).toBeInstanceOf(AnalysisInputError);
  const compared = bundleComparisonExecution({ left, right, recordPairs: [] });
  if (!compared.ok) throw compared.error;
  expect(compared.value.sources).toEqual([leftRecord, rightRecord]);
  expect(compared.value.evidence.evidence_links).toEqual(
    expect.arrayContaining([leftRecord.evidence_id, rightRecord.evidence_id]),
  );
});
