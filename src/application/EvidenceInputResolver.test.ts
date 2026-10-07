import { describe, expect, it } from "vitest";
import { evidenceInputSchema } from "../contracts/evidenceInputContracts.js";
import { JAVASCRIPT_FEATURE_TRACE_EXAMPLE } from "../contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { EvidenceLedger } from "./investigation/EvidenceLedger.js";
import { resolveEvidenceInput } from "./EvidenceInputResolver.js";

const evidence = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
const reference = {
  kind: "retained-evidence" as const,
  evidence_id: evidence.evidence_id,
};

describe("exact Evidence input resolution", () => {
  it("uses the session's detached canonical record without modifying it", () => {
    const ledger = new EvidenceLedger();
    expect(ledger.record(evidence).ok).toBe(true);
    const result = resolveEvidenceInput(reference, (id) => ledger.get(id));
    if (!result.ok) throw result.error;
    expect(result.value).toEqual(evidence);
    result.value.limitations.push("caller-owned change");
    expect(ledger.get(evidence.evidence_id)).toEqual(evidence);
  });

  it("leaves portable inline inputs independent of session lookup", () => {
    expect(
      resolveEvidenceInput(evidence, () => {
        throw new Error("unexpected lookup");
      }),
    ).toEqual({ ok: true, value: evidence });
  });

  it("reports a missing reference and an available recovery", () => {
    for (const lookup of [undefined, () => undefined]) {
      const result = resolveEvidenceInput(reference, lookup);
      if (result.ok) throw new Error("unknown reference was resolved");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        details: {
          evidence_id: reference.evidence_id,
          reason: "missing",
          actual: null,
        },
      });
      expect(projected.message).toContain("not retained in this session");
      expect(projected.remediation.action).toContain(
        "complete inline Evidence",
      );
    }
  });

  it("rejects a lookup returning another record rather than guessing identity", () => {
    const otherId = `ev_${"f".repeat(64)}`;
    const result = resolveEvidenceInput(
      { ...reference, evidence_id: otherId },
      () => evidence,
    );
    if (result.ok) throw new Error("mismatched reference was resolved");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: {
        reason: "identity_mismatch",
        expected: otherId,
        actual: evidence.evidence_id,
      },
    });
  });

  it("parses only complete inline records or strict exact references", () => {
    expect(evidenceInputSchema.safeParse(reference).success).toBe(true);
    expect(evidenceInputSchema.safeParse(evidence).success).toBe(true);
    for (const invalid of [
      { evidence_id: evidence.evidence_id },
      { ...reference, kind: "another-session" },
      { ...reference, evidence_id: "ev_short" },
      { ...reference, session_id: "foreign" },
      { ...reference, normalized_result: {} },
    ])
      expect(evidenceInputSchema.safeParse(invalid).success).toBe(false);
  });
});
