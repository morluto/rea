import { expect, it } from "vitest";

import type { Evidence } from "../domain/evidence.js";
import type { ReviewedReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";
import { parseProcessCaptureEvidence } from "./process/ProcessEvidence.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";
import {
  processEvidence,
  request,
  resolveRequest,
  reviewedObligation,
} from "./ReconstructionObligationLedger.fixture.js";

const RETIREMENTS = 50;

it.each([
  ["another artifact", false],
  ["the capture's own artifact", true],
] as const)(
  "parses a capture cited by many retirements of %s once per request",
  (_, ownArtifact) => {
    const capture = processEvidence();
    const executableSha256 = (
      capture.normalized_result as {
        readonly manifest: { readonly executable_sha256: string };
      }
    ).manifest.executable_sha256;
    const retirements: ReviewedReconstructionObligation[] = Array.from(
      { length: RETIREMENTS },
      (_unused, index) => ({
        ...reviewedObligation(`obl.retired.${index}`, capture.evidence_id),
        target: {
          artifact_sha256: ownArtifact ? executableSha256 : "c".repeat(64),
          application_node_id: null,
          semantic_node_id: null,
          location: `/reviewed/retired/${index}`,
        },
        disposition: "out-of-scope",
        disposition_reason: "Outside the reconstruction scope.",
      }),
    );
    const parsedIds: string[] = [];
    const countingParser = (evidence: Evidence) => {
      parsedIds.push(evidence.evidence_id);
      return parseProcessCaptureEvidence(evidence);
    };

    const { candidates } = deriveReconstructionObligationCandidates(
      resolveRequest(request([capture], { reviewed_obligations: retirements })),
      countingParser,
    );

    const reviewed = candidates.filter(({ origin }) => origin === "reviewed");
    expect(reviewed).toHaveLength(RETIREMENTS);
    for (const candidate of reviewed)
      expect(candidate.authority_references).toEqual([
        expect.objectContaining({
          evidence_id: capture.evidence_id,
          authority: "controlled-replay",
          state: ownArtifact ? "observed" : "other-artifact",
        }),
      ]);
    expect(parsedIds).toEqual([capture.evidence_id]);
  },
);
