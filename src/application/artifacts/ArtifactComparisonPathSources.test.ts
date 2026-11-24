import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inventoryArtifact } from "../../artifacts/inventory/ArtifactInventory.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { artifactInventorySubject } from "../../domain/artifactInventoryEvidence.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../../domain/investigationProviders.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { verifyReconstruction } from "../../domain/reconstructionVerification.js";
import { err, ok } from "../../domain/result.js";
import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import {
  compareArtifactEvidence,
  resolveArtifactComparisonSources,
} from "./ArtifactComparisonEvidence.js";
import {
  executeArtifactPathInspection,
  retainedInArtifactScope,
  type ArtifactPathInspectionDependencies,
} from "./ArtifactPathInspection.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { createAnalysisExecution } from "../../ports/AnalysisProvider.js";

const inventoryEvidence = async (
  path: string,
  acquisitionLimits?: { maximumEntries: number; maximumBytes: number },
): Promise<Evidence> => {
  const resourceScope = new ArtifactResourceScope();
  try {
    const inventory = await inventoryArtifact(path, {
      environment: {},
      resourceScope,
      ...(acquisitionLimits === undefined ? {} : { acquisitionLimits }),
    });
    return createEvidence(
      artifactInventorySubject(path, inventory),
      ARTIFACT_GRAPH_PROVIDER,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: inventory,
        rawResult: null,
        limitations: inventory.limitations,
      },
    );
  } finally {
    await resourceScope.close();
  }
};

const build = async (root: string, files: readonly string[]) => {
  await mkdir(root, { recursive: true });
  for (const file of files) await writeFile(join(root, file), file);
};

it("keeps the completed left inventory when the right path fails", async () => {
  const base = await createTestTempDirectory("rea-compare-path-failure-");
  const left = join(base, "left");
  await build(left, ["a.txt"]);
  const leftEvidence = await inventoryEvidence(left);
  const failure = new AnalysisInputError("compare_artifacts", undefined, [
    { path: ["right"], reason: "invalid_value", message: "unreadable" },
  ]);

  const resolved = await resolveArtifactComparisonSources(
    {
      left: { kind: "path", path: left },
      right: { kind: "path", path: join(base, "missing") },
    },
    undefined,
    {
      inventoryPath: async (source) =>
        source.path === left ? ok(leftEvidence) : err(failure),
    },
  );

  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.error).toBe(failure);
  expect(resolved.error.argumentObservations).toEqual([
    { argument: "left", observation: leftEvidence },
  ]);
});

it("compares a partial directory's summary as partial instead of refusing it", async () => {
  const base = await createTestTempDirectory("rea-compare-partial-summary-");
  const root = join(base, "build");
  await build(root, ["a.txt", "b.txt", "c.txt"]);
  const partial = await inventoryEvidence(root, {
    maximumEntries: 1,
    maximumBytes: 1 << 20,
  });
  expect(partial.subject.identity).toEqual({
    kind: "unknown",
    reason: "not-observed",
  });
  const records = new Map<string, Evidence>([[partial.evidence_id, partial]]);
  const summary = await inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: partial.evidence_id },
      view: { kind: "summary" },
    },
    (id) => records.get(id),
  );
  if (!summary.ok) throw summary.error;
  records.set(summary.value.evidence_id, summary.value);

  const sources = await resolveArtifactComparisonSources(
    {
      left: {
        kind: "retained-evidence",
        evidence_id: summary.value.evidence_id,
      },
      right: { kind: "retained-evidence", evidence_id: partial.evidence_id },
    },
    (id) => records.get(id),
  );
  if (!sources.ok) throw sources.error;
  // The summary resolves to its exact partial parent.
  expect(sources.value.left.evidence_id).toBe(partial.evidence_id);
  const compared = compareArtifactEvidence(sources.value);
  if (!compared.ok) throw compared.error;
  expect(compared.value.comparison.status).not.toBe("unchanged");
  expect(compared.value.comparison.limitations).toEqual(
    expect.arrayContaining([
      "Left artifact inventory traversal coverage is unknown.",
      "Right artifact inventory traversal coverage is unknown.",
    ]),
  );
});

it("settles a structural-artifact claim from two complete directory inventories", async () => {
  const base = await createTestTempDirectory("rea-compare-directory-claim-");
  const original = join(base, "original");
  const same = join(base, "same");
  const changed = join(base, "changed");
  await build(original, ["a.txt", "b.txt"]);
  await build(same, ["a.txt", "b.txt"]);
  await build(changed, ["a.txt", "c.txt"]);
  const verify = async (reconstruction: string) => {
    const left = await inventoryEvidence(original);
    const right = await inventoryEvidence(reconstruction);
    expect(left.subject.identity.kind).toBe("directory");
    const compared = compareArtifactEvidence({ left, right });
    if (!compared.ok) throw compared.error;
    return verifyReconstruction(
      {
        name: "Build output",
        claims: [
          {
            kind: "structural-artifact",
            claim_id: "build-output",
            title: "Build output is unchanged",
            comparison_evidence_id: compared.value.evidence.evidence_id,
            dimension: "overall",
          },
        ],
      },
      // Identical trees at two paths are one path-free observation.
      createEvidenceBundle([
        ...new Map(
          [left, right, compared.value.evidence].map((record) => [
            record.evidence_id,
            record,
          ]),
        ).values(),
      ]),
    );
  };
  // A confirmed difference fails the claim instead of leaving it unknown.
  const failed = await verify(changed);
  expect(failed.status).toBe("fail");
  expect(JSON.stringify(failed)).not.toContain(
    "Structural source artifact identity is unavailable.",
  );
  // Identical trees at two paths are one observation, so they cannot serve
  // as independent original and reconstruction sources.
  expect((await verify(same)).status).toBe("unknown");
});

it("keeps a partial directory root unknown instead of reporting a false content change against a complete scan", async () => {
  const base = await createTestTempDirectory("rea-compare-partial-root-");
  const root = join(base, "build");
  await build(root, ["a.txt", "b.txt", "c.txt"]);
  const complete = await inventoryEvidence(root);
  const partial = await inventoryEvidence(root, {
    maximumEntries: 1,
    maximumBytes: 1 << 20,
  });

  const mixed = compareArtifactEvidence({ left: complete, right: partial });
  if (!mixed.ok) throw mixed.error;
  const mixedRoot = mixed.value.comparison.changes.find(
    ({ logical_path }) => logical_path === ".",
  );
  expect(mixedRoot).toMatchObject({
    logical_path: ".",
    classification: "unknown",
    dimensions: ["availability"],
  });

  const bothPartial = compareArtifactEvidence({
    left: partial,
    right: partial,
  });
  if (!bothPartial.ok) throw bothPartial.error;
  const partialRoot = bothPartial.value.comparison.changes.find(
    ({ logical_path }) => logical_path === ".",
  );
  expect(partialRoot).toMatchObject({
    logical_path: ".",
    classification: "unknown",
    dimensions: ["availability"],
  });
});

it("retries retained cleanup before starting later path inspections and blocks while cleanup fails", async () => {
  const base = await createTestTempDirectory("rea-path-cleanup-retry-");
  const dir = join(base, "dir");
  await build(dir, ["a.txt"]);
  const scope = new ArtifactResourceScope();
  const retained = retainedInArtifactScope(scope);
  let closeAttempts = 0;
  let allowClose = false;
  let inspectCalls = 0;

  const dependencies: ArtifactPathInspectionDependencies = {
    inspectArtifactDirectory: async (
      _path,
      _parameters,
      _options,
      scopeRef,
    ) => {
      inspectCalls += 1;
      if (inspectCalls === 1) {
        scopeRef?.retain(
          {
            close: async () => {
              closeAttempts += 1;
              if (!allowClose) throw new Error("reader still busy");
            },
          },
          "directory reader",
        );
        return err(
          new ProviderCleanupError(
            ARTIFACT_GRAPH_PROVIDER.id,
            ["directory reader"],
            { reason: "reader still busy" },
          ),
        );
      }
      return ok(createAnalysisExecution(null, ARTIFACT_GRAPH_PROVIDER));
    },
    createArtifactBinarySession: async () => {
      throw new Error("unexpected binary session for directory");
    },
  };

  const first = await executeArtifactPathInspection(
    dependencies,
    dir,
    {},
    {},
    retained,
  );
  expect(first.ok).toBe(false);
  expect(inspectCalls).toBe(1);

  const blocked = await executeArtifactPathInspection(
    dependencies,
    dir,
    {},
    {},
    retained,
  );
  expect(blocked.ok).toBe(false);
  if (!blocked.ok)
    expect(projectAnalysisError(blocked.error).code).toBe("cleanup_incomplete");
  expect(closeAttempts).toBe(1);
  expect(inspectCalls).toBe(1);

  allowClose = true;
  const recovered = await executeArtifactPathInspection(
    dependencies,
    dir,
    {},
    {},
    retained,
  );
  expect(recovered.ok).toBe(true);
  expect(closeAttempts).toBe(2);
  expect(inspectCalls).toBe(2);
  await scope.close();
});
