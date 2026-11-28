import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { UNKNOWN_EVIDENCE_SUBJECT } from "../../../tests/fixtures/evidenceSubject.js";
import {
  ANALYSIS_VIEW_PAGE_BYTES,
  ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY,
  ANALYSIS_VIEW_REFUSAL_PARENT_NOTE,
  analysisViewPageTooLarge,
} from "./analysisViewErrors.js";
import { projectNativeFunctionMatchingView } from "./nativeFunctionMatchingView.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";

describe("analysis-view page refusal recovery", () => {
  it("distinguishes refused view projections from completed parent Evidence", () => {
    const defaultRefusal = analysisViewPageTooLarge(
      `ev_${"a".repeat(64)}`,
      "Page exceeded limit.",
      { collection: "rows" },
    );
    if (defaultRefusal.ok) throw new Error("expected refusal");
    const projectedDefault = projectAnalysisError(defaultRefusal.error);
    expect(projectedDefault.remediation.action).toContain(
      ANALYSIS_VIEW_REFUSAL_PARENT_NOTE,
    );
    expect(projectedDefault.remediation.action).not.toContain(
      "does not leave a completed report or Evidence record",
    );

    const customRefusal = analysisViewPageTooLarge(
      `ev_${"a".repeat(64)}`,
      "Summary exceeded limit.",
      { narrowing: "Select complete detail." },
    );
    if (customRefusal.ok) throw new Error("expected refusal");
    const projectedCustom = projectAnalysisError(customRefusal.error);
    expect(projectedCustom.remediation.action).toContain(
      `${ANALYSIS_VIEW_REFUSAL_PARENT_NOTE} Select complete detail.`,
    );
    expect(projectedCustom.remediation.action).not.toContain(
      "does not leave a completed report or Evidence record",
    );

    const sharedRecoveryError = new AnalysisResourceConstraintError(
      "inspect_analysis_view",
      "transport",
      "GPU view exceeded limit.",
      { limit_bytes: ANALYSIS_VIEW_PAGE_BYTES },
      ANALYSIS_VIEW_PAGE_BUDGET_RECOVERY,
    );
    const projectedShared = projectAnalysisError(sharedRecoveryError);
    expect(projectedShared.remediation.action).toContain(
      ANALYSIS_VIEW_REFUSAL_PARENT_NOTE,
    );
    expect(projectedShared.remediation.action).not.toContain(
      "does not leave a completed report or Evidence record",
    );
  });

  it("preserves parent availability in native function-matching byte-source refusals", () => {
    const leftId = `ev_${"1".repeat(64)}`;
    const rightId = `ev_${"2".repeat(64)}`;
    const fnId = `${leftId}/0`;
    const matchId = `match_${digestCanonicalValue({
      state: "only_left",
      basis: null,
      left: [fnId],
      right: [],
    })}`;
    const parent = {
      predicateType: "rea.native-function-matching" as const,
      evidenceId: `ev_${"c".repeat(64)}`,
      operation: "match_native_functions",
      normalizedResult: {
        left: {
          evidence_id: leftId,
          sha256: "a".repeat(64),
          functions: 1,
        },
        right: {
          evidence_id: rightId,
          sha256: "b".repeat(64),
          functions: 0,
        },
        scope: "provider-observed-inputs" as const,
        source_coverage: {
          status: "partial" as const,
          left_inventory_completeness: "unknown" as const,
          right_inventory_completeness: "unknown" as const,
          left_byte_fingerprints: 0,
          right_byte_fingerprints: 0,
          left_structural_candidates: 0,
          right_structural_candidates: 0,
        },
        summary: {
          matched: 0,
          only_left: 1,
          only_right: 0,
          unresolved: 0,
        },
        byte_sources_count: 1,
        matches: [
          {
            match_id: matchId,
            state: "only_left" as const,
            basis: null,
            left: [
              {
                function_id: fnId,
                inventory_evidence_id: leftId,
                source_index: 0,
                address: "0x1000",
                name: "sub_1000",
                body_sha256: null,
                structural_candidate_sha256: null,
                body_bytes: null,
                dossier_evidence_id: null,
                evidence_links: [leftId],
                limitations: [],
              },
            ],
            right: [],
            reason: "Only observed on left",
            compare_functions_input: null,
          },
        ],
        limitations: [],
        byte_sources: [
          {
            side: "left" as const,
            evidence_id: leftId,
            limitations: ["x".repeat(ANALYSIS_VIEW_PAGE_BYTES + 128)],
          },
        ],
      },
      rawResult: null,
      sealedResult: true,
      provider: { id: "rea", name: "REA", version: "1" },
      artifact: null,
      subject: UNKNOWN_EVIDENCE_SUBJECT,
      parameters: {},
      limitations: [],
    };
    const request = analysisViewRequestSchema.parse({
      kind: "function-matches",
      collection: "byte-sources",
      offset: 0,
      limit: 1,
    });
    const result = projectNativeFunctionMatchingView(parent, request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    const projected = projectAnalysisError(result.error);
    expect(projected.remediation.action).toContain(
      ANALYSIS_VIEW_REFUSAL_PARENT_NOTE,
    );
    expect(projected.remediation.action).not.toContain(
      "does not leave a completed report or Evidence record",
    );
  });
});
