import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../src/application/AnalysisSnapshotFiles.js";
import { AnalysisSnapshotCache } from "../src/application/AnalysisSnapshotCache.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  snapshotEvidenceForQuery,
  type AnalysisSnapshot,
} from "../src/domain/analysisSnapshot.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createAnalysisExecution } from "../src/application/AnalysisProvider.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("analysis snapshots", () => {
  it("returns detached cache entries and evidence bundles", () => {
    const cache = new AnalysisSnapshotCache();
    const target = {
      path: "/tmp/app",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "mach-o",
      architecture: "arm64",
      loaderArgs: [],
    } as const;
    const provider = { id: "fixture", name: "Fixture", version: "1" };
    cache.record(
      target,
      "address_name",
      { address: "0x1000", document: "fixture" },
      createAnalysisExecution("main", provider),
    );
    const exported = cache.export(target, createEvidenceBundle([]));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const entry = exported.value.entries[0];
    if (entry !== undefined) {
      Reflect.set(entry.execution, "provider", {
        id: "forged",
        name: "Forged",
        version: "9",
      });
      (entry.execution.limitations as string[]).push("forged");
    }

    expect(
      cache.lookup(
        target,
        "address_name",
        { address: "0x1000", document: "fixture" },
        provider,
      ),
    ).toMatchObject({
      provider,
      limitations: [expect.stringContaining("local REA analysis snapshot")],
    });
  });

  it("finds exact CLI evidence for provider-free replay", () => {
    const target = {
      path: "/tmp/app",
      sha256: "b".repeat(64),
      kind: "executable",
      format: "mach-o",
      architecture: "arm64",
      loaderArgs: [],
    } as const;
    const evidence = createEvidence(
      target,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "analyze_function",
        parameters: { procedure: "main" },
        result: { summary: "cached" },
      },
    );
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 1,
      target: {
        sha256: target.sha256,
        format: target.format,
        architecture: target.architecture,
        loader_args: [],
      },
      entries: [],
      evidence_bundle: createEvidenceBundle([evidence]),
    };
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target,
        operation: "analyze_function",
        parameters: {
          procedure: "main",
        },
        provider: { id: "fixture", name: "Fixture", version: "1" },
      }),
    ).toEqual(evidence);
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target,
        operation: "analyze_function",
        parameters: {
          procedure: "other",
        },
        provider: { id: "fixture", name: "Fixture", version: "1" },
      }),
    ).toBeUndefined();
  });

  it("writes canonical private JSON and rejects a changed query identity", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-analysis-snapshot-"));
    const path = join(directory, "analysis.json");
    const target: AnalysisSnapshot["target"] = {
      sha256: "a".repeat(64),
      format: "mach-o",
      architecture: "arm64",
      loader_args: [],
    };
    const entry = createAnalysisSnapshotEntry(
      target,
      "address_name",
      { address: "0x1000" },
      createAnalysisExecution("main", {
        id: "fixture",
        name: "Fixture analysis provider",
        version: "1",
      }),
    );
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 1,
      target,
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

    const altered = JSON.parse(await readFile(path, "utf8"));
    altered.entries[0].parameters.address = "0x2000";
    await writeFile(path, JSON.stringify(altered));
    const loaded = await readAnalysisSnapshot(path, policy);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error._tag).toBe("EvidenceIntegrityError");
    expect(() => parseAnalysisSnapshot(altered)).toThrow(/identifier/u);
  });
});
