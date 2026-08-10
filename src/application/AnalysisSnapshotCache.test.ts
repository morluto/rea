import { describe, expect, it } from "vitest";

import { createAnalysisProfile } from "../domain/analysisProfile.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET,
} from "../domain/analysisSnapshot.fixture.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { createAnalysisExecution } from "./AnalysisProvider.js";
import { AnalysisSnapshotCache } from "./AnalysisSnapshotCache.js";

describe("analysis snapshot cache partitioning", () => {
  it("returns detached data only from the exact provider/profile partition", () => {
    const cache = new AnalysisSnapshotCache();
    const execution = createAnalysisExecution(
      "main",
      ANALYSIS_SNAPSHOT_PROVIDER,
      { analysisProfile: ANALYSIS_SNAPSHOT_PROFILE },
    );
    cache.record({
      target: ANALYSIS_SNAPSHOT_TARGET,
      profile: ANALYSIS_SNAPSHOT_PROFILE,
      operation: "address_name",
      parameters: { address: "0x1000", document: "fixture" },
      execution,
    });
    const exported = cache.export(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROFILE,
      createEvidenceBundle([]),
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const entry = exported.value.entries[0];
    if (entry !== undefined) {
      Reflect.set(entry.execution, "provider", {
        id: "forged",
        name: "Forged",
        version: "9",
      });
      entry.execution.limitations.push("forged");
    }

    expect(
      cache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        ANALYSIS_SNAPSHOT_PROFILE,
        "address_name",
        { address: "0x1000", document: "fixture" },
      ),
    ).toMatchObject({
      provider: ANALYSIS_SNAPSHOT_PROVIDER,
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      limitations: [expect.stringContaining("local REA analysis snapshot")],
    });
    const changedProfile = createAnalysisProfile(
      ANALYSIS_SNAPSHOT_PROVIDER,
      1,
      { loader: "configured-override" },
    );
    expect(
      cache.lookup(ANALYSIS_SNAPSHOT_TARGET, changedProfile, "address_name", {
        address: "0x1000",
        document: "fixture",
      }),
    ).toBeUndefined();
    const changedProviderProfile = createAnalysisProfile(
      { id: "other", name: "Other", version: "1" },
      1,
      { loader: "mach-o-arm64" },
    );
    expect(
      cache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        changedProviderProfile,
        "address_name",
        { address: "0x1000", document: "fixture" },
      ),
    ).toBeUndefined();
  });
});
