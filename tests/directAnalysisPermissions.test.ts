import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeAnalysisSnapshot } from "../src/application/AnalysisSnapshotFiles.js";
import { runDirectAnalysis } from "../src/application/DirectAnalysis.js";
import type { AnalysisSnapshot } from "../src/domain/analysisSnapshot.js";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

let directory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("direct analysis snapshot permissions", () => {
  it("replays a cache hit with snapshot read authority only", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-direct-snapshot-"));
    const snapshotPath = join(directory, "analysis.json");
    const target = await parseBinaryTarget(process.execPath);
    if (!target.ok) throw target.error;
    const provider = {
      id: "rea-workflow",
      name: "REA composed investigation workflow",
      version: "1",
    } as const;
    const evidence = createEvidence(target.value, provider, {
      operation: "binary_overview",
      parameters: {},
      result: { cached: true },
    });
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 1,
      target: {
        sha256: target.value.sha256,
        format: target.value.format,
        architecture: target.value.architecture ?? null,
        loader_args: [...target.value.loaderArgs],
      },
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
