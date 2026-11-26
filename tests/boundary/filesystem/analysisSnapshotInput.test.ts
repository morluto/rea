import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  snapshotBinding,
  snapshotTarget,
} from "../../../src/domain/analysisSnapshot.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE,
  ANALYSIS_SNAPSHOT_TARGET,
} from "../../../src/domain/analysisSnapshot.fixture.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { RECREATE_EVIDENCE_GUIDANCE } from "../../../src/domain/evidenceFormat.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";

const emptySnapshot = () => ({
  target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
  binding: snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE),
  entries: [],
  workflow_entries: [],
  evidence_bundle: createEvidenceBundle([]),
});

describe.each([
  { mode: "native", paddingBytes: 0, nonObjectRoots: ["[{}]", "null", "true"] },
  {
    mode: "streamed",
    paddingBytes: 9 * 1024 * 1024,
    nonObjectRoots: ["[{}]", "true"],
  },
])("analysis snapshot input ($mode)", ({ paddingBytes, nonObjectRoots }) => {
  it.each([
    {
      label: "header",
      document: { entries: [], workflow_entries: [] },
      field: "target",
    },
    {
      label: "provider entry",
      document: { entries: [{}], workflow_entries: [] },
      field: "entries.0.query_id",
    },
    {
      label: "workflow entry",
      document: { entries: [], workflow_entries: [{}] },
      field: "workflow_entries.0.query_id",
    },
  ])(
    "retains the first $label schema diagnostic through the file wrapper",
    async ({ document, field }) => {
      const root = await createTestTempDirectory(
        "rea-snapshot-schema-diagnostic-",
      );
      const path = join(root, "snapshot.json");
      const encoded = `${" ".repeat(paddingBytes)}${JSON.stringify(document)}`;
      await writeFile(path, encoded);
      const loaded = await readAnalysisSnapshot(path);
      if (loaded.ok) throw new Error("Expected invalid snapshot refusal");
      expect(loaded.error.cause).toMatchObject({ name: "ZodError" });
      const projected = projectAnalysisError(loaded.error);
      expect(projected).toMatchObject({
        code: "evidence_integrity_mismatch",
        category: "integrity_mismatch",
        retryable: false,
        details: {
          reason: expect.stringContaining(`at ${field}:`),
          issue_path: field
            .split(".")
            .map((key) => (/^\d+$/u.test(key) ? Number(key) : key)),
        },
      });
      if (field === "target")
        expect(projected.details?.remaining_issue_count).toBe(2);
      expect(projected).not.toHaveProperty("cause");
      expect(projected).not.toHaveProperty("stack");
      expect(await readFile(path, "utf8")).toBe(encoded);
    },
  );

  it.each(nonObjectRoots)(
    "classifies a readable %s root as invalid content, not an I/O failure",
    async (document) => {
      const root = await createTestTempDirectory("rea-snapshot-root-");
      const path = join(root, "snapshot.json");
      const encoded = `${" ".repeat(paddingBytes)}${document}`;
      await writeFile(path, encoded);

      const loaded = await readAnalysisSnapshot(path);
      if (loaded.ok) throw new Error("Expected a non-object root rejection");
      const projected = projectAnalysisError(loaded.error);
      expect(projected).toMatchObject({
        code: "evidence_integrity_mismatch",
        details: { reason: "invalid-json" },
      });
      expect(projected.message).toContain("Repair or recreate");
      expect(loaded.error.cause).toMatchObject({
        message: "JSON document root must be an object",
      });
      expect(await readFile(path, "utf8")).toBe(encoded);
    },
  );

  it("retains syntax and snapshot-member validation and loads valid objects", async () => {
    const root = await createTestTempDirectory("rea-snapshot-validation-");
    const path = join(root, "snapshot.json");
    const prefix = " ".repeat(paddingBytes);
    await writeFile(path, `${prefix}[`);
    expect(await readAnalysisSnapshot(path)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceFileError", reason: "invalid-json" },
    });
    await writeFile(path, `${prefix}{}`);
    expect(await readAnalysisSnapshot(path)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    const snapshot = emptySnapshot();
    await writeFile(path, `${prefix}${JSON.stringify(snapshot)}`);
    expect(await readAnalysisSnapshot(path)).toEqual({
      ok: true,
      value: snapshot,
    });
  });
});

it("refuses a snapshot holding an earlier-format bundle with the recreate guidance", async () => {
  const root = await createTestTempDirectory("rea-snapshot-evidence-format-");
  const path = join(root, "snapshot.json");
  const { evidence_format: _current, ...unmarked } = createEvidenceBundle([]);
  await writeFile(
    path,
    JSON.stringify({ ...emptySnapshot(), evidence_bundle: unmarked }),
  );
  const loaded = await readAnalysisSnapshot(path);
  if (loaded.ok) throw new Error("Expected the earlier format to be refused");
  const projected = projectAnalysisError(loaded.error);
  expect(projected).toMatchObject({
    code: "evidence_integrity_mismatch",
    details: {
      reason: expect.stringContaining(
        "This Evidence bundle predates format revision",
      ),
    },
  });
  expect(projected.details?.reason).toContain(RECREATE_EVIDENCE_GUIDANCE);
});

it("locates a bundle schema issue within the snapshot when reading and writing", async () => {
  const root = await createTestTempDirectory("rea-snapshot-bundle-issue-");
  const { providers: _providers, ...bundle } = createEvidenceBundle([]);
  const snapshot = { ...emptySnapshot(), evidence_bundle: bundle };
  const path = join(root, "snapshot.json");
  await writeFile(path, JSON.stringify(snapshot));
  const read = await readAnalysisSnapshot(path);
  const written = await withArtifactResourceScope((resources) =>
    writeAnalysisSnapshot(
      snapshot as never,
      join(root, "written.json"),
      false,
      resources,
    ),
  );
  for (const result of [read, written]) {
    if (result.ok) throw new Error("Expected invalid bundle refusal");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        reason: expect.stringContaining("at evidence_bundle.providers:"),
        issue_path: ["evidence_bundle", "providers"],
      },
    });
  }
});

it("retains serialization schema diagnostics without creating a snapshot file", async () => {
  const root = await createTestTempDirectory("rea-snapshot-write-diagnostic-");
  const path = join(root, "snapshot.json");
  const snapshot = emptySnapshot();
  Reflect.deleteProperty(snapshot, "binding");
  const written = await withArtifactResourceScope((resources) =>
    writeAnalysisSnapshot(snapshot, path, false, resources),
  );
  if (written.ok) throw new Error("Expected invalid snapshot refusal");
  expect(written.error.cause).toMatchObject({ name: "ZodError" });
  expect(projectAnalysisError(written.error)).toMatchObject({
    code: "evidence_integrity_mismatch",
    details: { reason: expect.stringContaining("at binding:") },
  });
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps file-selection failures distinct from invalid snapshot contents", async () => {
  const root = await createTestTempDirectory("rea-snapshot-selection-");
  for (const [path, reason] of [
    [join(root, "missing.json"), "missing"],
    [root, "not-file"],
  ] as const) {
    const loaded = await readAnalysisSnapshot(path);
    if (loaded.ok) throw new Error("Expected a file-selection failure");
    expect(projectAnalysisError(loaded.error)).toMatchObject({
      code: "invalid_request",
      details: { reason },
    });
  }
});
