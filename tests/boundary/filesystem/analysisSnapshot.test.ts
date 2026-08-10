import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../../../src/application/AnalysisSnapshotFiles.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  snapshotBinding,
  snapshotTarget,
  type AnalysisSnapshot,
} from "../../../src/domain/analysisSnapshot.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE as PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER as PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET as TARGET,
} from "../../../src/domain/analysisSnapshot.fixture.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";

describe("analysis snapshots: persistence", () => {
  it("writes canonical private v2 JSON and rejects changed query identity", async () => {
    const directory = await createTestTempDirectory("rea-snapshot-");
    const path = join(directory, "analysis.json");
    const target = snapshotTarget(TARGET);
    const binding = snapshotBinding(PROFILE);
    const entry = createAnalysisSnapshotEntry({
      target,
      binding,
      operation: "address_name",
      parameters: { address: "0x1000" },
      execution: createAnalysisExecution("main", PROVIDER, {
        analysisProfile: PROFILE,
      }),
    });
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 2,
      target,
      binding,
      entries: [entry],
      evidence_bundle: createEvidenceBundle([]),
    };
    const policy = {
      roots: [directory],
      maxBytes: 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024,
      maxNodes: 10_000,
    };
    const written = await writeAnalysisSnapshot(snapshot, path, false, policy);
    expect(written.ok).toBe(true);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readAnalysisSnapshot(path, policy)).ok).toBe(true);

    const altered: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof altered !== "object" ||
      altered === null ||
      !("entries" in altered) ||
      !Array.isArray(altered.entries)
    )
      throw new TypeError("fixture snapshot is malformed");
    const first: unknown = altered.entries[0];
    if (
      typeof first !== "object" ||
      first === null ||
      !("parameters" in first) ||
      typeof first.parameters !== "object" ||
      first.parameters === null
    )
      throw new TypeError("fixture entry is malformed");
    Reflect.set(first.parameters, "address", "0x2000");
    await writeFile(path, JSON.stringify(altered));
    const loaded = await readAnalysisSnapshot(path, policy);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error._tag).toBe("EvidenceIntegrityError");
    expect(() => parseAnalysisSnapshot(altered)).toThrow(/identifier/u);
  });
});
