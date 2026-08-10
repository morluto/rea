import { describe, expect, it } from "vitest";

import {
  type AnalysisSnapshot,
  parseAnalysisSnapshot,
  snapshotBinding,
  snapshotEvidenceForQuery,
  snapshotTarget,
} from "./analysisSnapshot.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET,
} from "./analysisSnapshot.fixture.js";
import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";

describe("analysis snapshot contract", () => {
  it("finds only Evidence committed to the exact binding and profile", () => {
    const evidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: "analyze_function",
        parameters: { procedure: "main" },
        result: { summary: "cached" },
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    );
    const legacy = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: "legacy_query",
        parameters: {},
        result: { summary: "legacy" },
      },
    );
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 2,
      target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
      binding: snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE),
      entries: [],
      evidence_bundle: createEvidenceBundle([evidence, legacy]),
    };
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: ANALYSIS_SNAPSHOT_TARGET,
        bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
        operation: "analyze_function",
        parameters: { procedure: "main" },
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
      }),
    ).toEqual(evidence);
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: ANALYSIS_SNAPSHOT_TARGET,
        bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
        operation: "legacy_query",
        parameters: {},
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
      }),
    ).toBeUndefined();
  });

  it("rejects snapshot v1 with explicit recapture guidance", () => {
    expect(() => parseAnalysisSnapshot({ snapshot_version: 1 })).toThrow(
      /v1.*recapture.*v2/iu,
    );
  });
});
