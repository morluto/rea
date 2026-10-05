import { describe, expect, it } from "vitest";

import {
  type AnalysisSnapshot,
  analysisSnapshotSchema,
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
  it("preserves DOS MZ target and subject formats with the x86 family", () => {
    const target = {
      path: ANALYSIS_SNAPSHOT_TARGET.path,
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      kind: "executable" as const,
      format: "dos-mz" as const,
      architecture: "x86" as const,
      availableArchitectures: ["x86" as const],
    };
    const evidence = createEvidence(target, ANALYSIS_SNAPSHOT_PROVIDER, {
      operation: "analyze_function",
      parameters: {},
      result: null,
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
    });
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const parsed = analysisSnapshotSchema.parse({
      target: snapshotTarget(target),
      binding,
      entries: [
        {
          query_id: `query_${"0".repeat(64)}`,
          operation: "analyze_function",
          parameters: {},
          execution: {
            result: null,
            raw_result: null,
            provider: binding.provider,
            limitations: [],
            locations: [],
            subject: target,
          },
        },
      ],
      evidence_bundle: createEvidenceBundle([evidence]),
    });
    expect(parsed.target).toMatchObject({
      format: "dos-mz",
      architecture: "x86",
    });
    expect(parsed.entries[0]?.execution.subject?.format).toBe("dos-mz");
    expect(parsed.evidence_bundle.records[0]?.subject?.format).toBe("dos-mz");
  });

  it("accepts snapshots with more than ten thousand analysis entries", () => {
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const entry = {
      query_id: `query_${"0".repeat(64)}`,
      operation: "analyze_function",
      parameters: {},
      execution: {
        result: null,
        raw_result: null,
        provider: binding.provider,
        limitations: [],
        locations: [],
        subject: null,
      },
    };

    const parsed = analysisSnapshotSchema.parse({
      target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
      binding,
      entries: Array.from({ length: 10_001 }, () => entry),
      evidence_bundle: createEvidenceBundle([]),
    });

    expect(parsed.entries).toHaveLength(10_001);
  });

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
});
