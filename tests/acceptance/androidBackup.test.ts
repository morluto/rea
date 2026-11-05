import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  backupImage,
  backupTar,
  encryptedBackupImage,
} from "../fixtures/androidBackup.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";

cliTest.for([false, true])(
  "inspects and selectively extracts an Android backup (compressed=%s)",
  async (compressed, { cli }) => {
    const root = await createTestTempDirectory("rea-ab-cli-");
    const source = join(root, "extensionless");
    const output = join(root, "selected");
    const image = backupImage(
      backupTar([
        { path: "apps/sample/f/state.json", data: '{"kept":true}' },
        { path: "apps/sample/f/other.txt", data: "not selected" },
      ]),
      { compressed },
    );
    await writeFile(source, image);
    const hash = createHash("sha256").update(image).digest("hex");
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const graph = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    expect(graph.manifest).toMatchObject({
      root_format: "android-backup",
      root_sha256: hash,
    });
    expect(graph.coverage).toMatchObject({ status: "complete" });
    const selected = graph.occurrences.find(
      (row) => row.logical_path === "apps/sample/f/state.json",
    )!;
    expect(selected).toMatchObject({
      hash_status: "verified",
      source_path: selected.logical_path,
      format_metadata: { kind: "android-backup-entry", tar_header_offset: 0 },
    });
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        source,
        "--output-root",
        output,
        "--occurrence-id",
        selected.occurrence_id,
        "--json",
      ],
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result).toMatchObject({
      output_root: output,
      extraction_manifest: {
        selected_occurrence_ids: [selected.occurrence_id],
      },
      containment_verified: true,
    });
    expect(await readFile(join(output, selected.logical_path), "utf8")).toBe(
      '{"kept":true}',
    );
    expect(await readdir(join(output, "apps/sample/f"))).toEqual([
      "state.json",
    ]);
    expect(
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    ).toBe(hash);
  },
);

cliTest(
  "reports encrypted coverage and refuses extraction before creating the selected destination",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ab-encrypted-cli-");
    const source = join(root, "encrypted.ab");
    const output = join(root, "refused");
    await writeFile(source, encryptedBackupImage());
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const graph = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    expect(graph.coverage).toMatchObject({ status: "unknown" });
    expect(graph.occurrences).toMatchObject([
      {
        encrypted: true,
        format_metadata: {
          kind: "android-backup",
          directory_status: "encrypted",
          payload_offset: null,
        },
      },
    ]);
    const refused = await cli.run({
      arguments: [
        "extract-artifact",
        source,
        "--output-root",
        output,
        "--json",
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.stringify(refused.json)).toContain("cannot be extracted");
    expect(await readdir(root)).toEqual(["encrypted.ab"]);
  },
);
