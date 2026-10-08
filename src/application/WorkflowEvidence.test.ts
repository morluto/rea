import { describe, expect, it } from "vitest";

import {
  recordWorkflowUnknowns,
  createWorkflowEvidence,
} from "./WorkflowEvidence.js";
import { InvestigationRecords } from "./investigation/InvestigationRecords.js";
import { UnknownRegistryError } from "../domain/unknownRegistryError.js";
import { err } from "../domain/result.js";

describe("workflow residual question retention", () => {
  it("keeps questions linked to workflow Evidence and records repeats idempotently", () => {
    const records = new InvestigationRecords();
    const result = {
      residual_unknowns: ["Which provider resolves this boundary?"],
    };
    const evidence = createWorkflowEvidence({
      target: undefined,
      operation: "inspect_native_api",
      parameters: { procedure: "0x1000" },
      result,
      upstreamProfile: undefined,
    });
    expect(records.recordEvidence(evidence).ok).toBe(true);
    const input = {
      name: "inspect_native_api",
      result,
      evidenceId: evidence.evidence_id,
      recordUnknown: (
        unknown: Parameters<InvestigationRecords["recordUnknown"]>[0],
      ) => records.recordUnknown(unknown),
    };
    expect(recordWorkflowUnknowns(input).ok).toBe(true);
    expect(recordWorkflowUnknowns(input).ok).toBe(true);
    expect(records.listUnknowns()).toMatchObject([
      {
        question: result.residual_unknowns[0],
        domain: "native-api",
        supporting_evidence_ids: [evidence.evidence_id],
        required_authority: "shipped-artifact",
      },
    ]);
    expect(records.listUnknowns()).toHaveLength(1);
  });

  it("preserves registry failures rather than presenting a completed workflow", () => {
    const error = new UnknownRegistryError("limit");
    expect(
      recordWorkflowUnknowns({
        name: "trace_feature",
        result: { residual_unknowns: ["Which branch handles the request?"] },
        evidenceId: "unretained",
        recordUnknown: () => err(error),
      }),
    ).toEqual(err(error));
  });
});
