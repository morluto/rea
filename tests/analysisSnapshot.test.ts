import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAnalysisExecution } from "../src/application/AnalysisProvider.js";
import { AnalysisSnapshotCache } from "../src/application/AnalysisSnapshotCache.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../src/application/AnalysisSnapshotFiles.js";
import { createAnalysisProfile } from "../src/domain/analysisProfile.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  snapshotBinding,
  snapshotEvidenceForQuery,
  snapshotTarget,
  type AnalysisSnapshot,
} from "../src/domain/analysisSnapshot.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";

let directory: string | undefined;

const TARGET: BinaryTarget = {
  path: "/tmp/app",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};
const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;
const PROFILE = createAnalysisProfile(PROVIDER, 1, {
  loader: "mach-o-arm64",
});

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("analysis snapshots", () => {
  it("returns detached cache data only from the exact provider/profile partition", () => {
    const cache = new AnalysisSnapshotCache();
    const execution = createAnalysisExecution("main", PROVIDER, {
      analysisProfile: PROFILE,
    });
    cache.record({
      target: TARGET,
      profile: PROFILE,
      operation: "address_name",
      parameters: { address: "0x1000", document: "fixture" },
      execution,
    });
    const exported = cache.export(TARGET, PROFILE, createEvidenceBundle([]));
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
      cache.lookup(TARGET, PROFILE, "address_name", {
        address: "0x1000",
        document: "fixture",
      }),
    ).toMatchObject({
      provider: PROVIDER,
      analysisProfile: PROFILE,
      limitations: [expect.stringContaining("local REA analysis snapshot")],
    });
    const changedProfile = createAnalysisProfile(PROVIDER, 1, {
      loader: "configured-override",
    });
    expect(
      cache.lookup(TARGET, changedProfile, "address_name", {
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
      cache.lookup(TARGET, changedProviderProfile, "address_name", {
        address: "0x1000",
        document: "fixture",
      }),
    ).toBeUndefined();
  });

  it("finds only Evidence committed to the exact binding and evidence profile", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "analyze_function",
      parameters: { procedure: "main" },
      result: { summary: "cached" },
      analysisProfile: PROFILE,
    });
    const legacy = createEvidence(TARGET, PROVIDER, {
      operation: "legacy_query",
      parameters: {},
      result: { summary: "legacy" },
    });
    const snapshot: AnalysisSnapshot = {
      snapshot_version: 2,
      target: snapshotTarget(TARGET),
      binding: snapshotBinding(PROFILE),
      entries: [],
      evidence_bundle: createEvidenceBundle([evidence, legacy]),
    };
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: TARGET,
        bindingProfile: PROFILE,
        operation: "analyze_function",
        parameters: { procedure: "main" },
        provider: PROVIDER,
        evidenceProfile: PROFILE,
      }),
    ).toEqual(evidence);
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: TARGET,
        bindingProfile: PROFILE,
        operation: "legacy_query",
        parameters: {},
        provider: PROVIDER,
        evidenceProfile: PROFILE,
      }),
    ).toBeUndefined();
  });

  it("writes canonical private v2 JSON and rejects changed query identity", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-analysis-snapshot-"));
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

  it("rejects snapshot v1 with explicit recapture guidance", () => {
    expect(() => parseAnalysisSnapshot({ snapshot_version: 1 })).toThrow(
      /v1.*recapture.*v2/iu,
    );
  });
});
