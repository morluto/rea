import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { writeAnalysisSnapshot } from "../src/application/AnalysisSnapshotFiles.js";
import { runDirectAnalysis } from "../src/application/DirectAnalysis.js";
import type { AnalysisSnapshot } from "../src/domain/analysisSnapshot.js";
import {
  snapshotBinding,
  snapshotTarget,
} from "../src/domain/analysisSnapshot.js";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../src/application/InvestigationProviders.js";
import { HOPPER_PROVIDER_IDENTITY } from "../src/hopper/HopperProvider.js";
import { resolveHopperAnalysisProfile } from "../src/hopper/HopperAnalysisProfile.js";

let directory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("direct analysis snapshot permissions", () => {
  it("forwards the CLI provider selector ahead of the environment preference", async () => {
    directory = await createTestTempDirectory("rea-direct-provider-");
    const targetPath = join(directory, "fixture.hop");
    await writeFile(targetPath, "fixture");
    vi.stubEnv("HOPPER_LAUNCHER_PATH", process.execPath);
    vi.stubEnv("REA_ANALYSIS_PROVIDER", "environment-provider");

    await expect(
      runDirectAnalysis(
        targetPath,
        "binary_overview",
        {},
        {
          providerId: "request-provider",
        },
      ),
    ).resolves.toMatchObject({
      error: "Analysis failed",
      code: "capability_unavailable",
      details: {
        selection_reason: "unknown_provider",
        requested_provider_id: "request-provider",
        candidate_ids: ["ghidra", "hopper"],
      },
    });
  });

  it("replays a cache hit with snapshot read authority only", async () => {
    directory = await createTestTempDirectory("rea-direct-snapshot-");
    const snapshotPath = join(directory, "analysis.json");
    const launcherPath = join(directory, "hopper-launcher");
    await writeFile(launcherPath, "fixture Hopper launcher");
    await chmod(launcherPath, 0o755);
    const target = await parseBinaryTarget(process.execPath);
    if (!target.ok) throw target.error;
    const resolved = await resolveHopperAnalysisProfile(target.value, {
      launcherPath,
      loaderArgsOverride: [],
      provider: HOPPER_PROVIDER_IDENTITY,
    });
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("fixture Hopper profile did not resolve");
    const profile = resolved.value.profile;
    const workflowProfile = workflowAnalysisProfile(profile);
    const evidence = createEvidence(target.value, REA_WORKFLOW_PROVIDER, {
      operation: "binary_overview",
      parameters: {},
      result: { cached: true },
      analysisProfile: workflowProfile,
    });
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 2,
      target: snapshotTarget(target.value),
      binding: snapshotBinding(profile),
      entries: [],
      evidence_bundle: createEvidenceBundle([evidence]),
    };
    const policy = {
      roots: [directory],
      maxBytes: 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024,
      maxNodes: 10_000,
    };
    expect(
      (await writeAnalysisSnapshot(snapshot, snapshotPath, false, policy)).ok,
    ).toBe(true);
    const authority = await permissionAuthorityForRoot(
      directory,
      ["snapshot_read", "snapshot_write"],
      ["snapshot_read"],
    );
    vi.stubEnv("REA_ANALYSIS_SNAPSHOT_ROOTS_JSON", JSON.stringify([directory]));
    vi.stubEnv("HOPPER_LAUNCHER_PATH", launcherPath);

    await expect(
      runDirectAnalysis(
        process.execPath,
        "binary_overview",
        {},
        {
          snapshotPath,
          permissionAuthority: authority,
        },
      ),
    ).resolves.toEqual(evidence);
  });
});
