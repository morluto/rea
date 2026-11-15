import { expect, it } from "vitest";

import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  webVerificationMutation,
  webVerificationScenario,
} from "../domain/reconstructionWebVerification.fixture.js";
import { compareWebEvidence } from "./WebComparisonEvidence.js";
import { verifyReconstructionRequest } from "./ReconstructionVerificationService.js";

it("requires the complete transitive source closure before returning a passing verification", () => {
  const dependency = webVerificationScenario({ duration: 3 });
  const left = webVerificationMutation(webVerificationScenario(), {
    evidence_links: [dependency.evidence_id],
  });
  const right = webVerificationScenario({ duration: 2 });
  const compared = compareWebEvidence("compare_web_captures", { left, right });
  if (!compared.ok) throw compared.error;
  const comparison = compared.value;
  const specification = {
    name: "Transitive proof closure",
    claims: [
      {
        claim_id: "settings.dom",
        title: "Selected DOM matches",
        kind: "web-scenario",
        dimension: "dom",
        step_id: "wait",
        comparison_evidence_id: comparison.evidence_id,
      },
    ],
  };
  const missing = verifyReconstructionRequest({
    specification,
    evidence_bundle: createEvidenceBundle([left, right, comparison]),
  });
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("Missing dependency must not pass");
  expect(missing.error).toMatchObject({ _tag: "EvidenceIntegrityError" });
  const complete = verifyReconstructionRequest({
    specification,
    evidence_bundle: createEvidenceBundle([
      left,
      right,
      comparison,
      dependency,
    ]),
  });
  if (!complete.ok) throw complete.error;
  expect(complete.value.status).toBe("pass");
  expect(complete.value.evidence_links).toContain(dependency.evidence_id);
});
