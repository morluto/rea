import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { sha256Hex } from "../../src/kernel/sha256Hex.js";
import { androidSuperFixture } from "../fixtures/androidSuperImage.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inventories a raw Android super image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-super-cli-");
    const path = `${root}/./firmware.bin`;
    const bytes = androidSuperFixture("raw");
    await writeFile(path, bytes);

    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const evidence = parseEvidence(inspected.json);
    expect(evidence.caller_input_path).toBe(path);
    const inspection = artifactInspectionResultSchema.parse(
      evidence.normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.manifest).toMatchObject({
      root_format: "android-super-image",
      root_sha256: sha256Hex(bytes),
    });
    expect(inventory.coverage.status).toBe("complete");
    expect(
      inventory.occurrences.find(
        (row) => row.logical_path === "slot-0/system_a",
      ),
    ).toMatchObject({
      entry_kind: "metadata",
      source_path: "system_a",
      source_location: { offset: 12416, length: 52 },
      artifact_id: null,
      format_metadata: {
        kind: "android-super-partition",
        group_name: "main",
        extents: [
          { record_offset: 12520, image_offset: 32768, length_bytes: "8192" },
        ],
      },
    });

    const output = join(root, "extracted");
    const extracted = await cli.run({
      arguments: ["extract-artifact", path, "--output-root", output, "--json"],
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(1);
    expect(extracted.json).toMatchObject({ code: "unsupported_target" });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "reports a typed refusal for corrupted Android super tables",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-super-bad-cli-");
    const path = join(root, "super_empty.img");
    const bytes = androidSuperFixture("template");
    bytes[4352] = bytes[4352]! ^ 1;
    await writeFile(path, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(1);
    expect(inspected.json).toMatchObject({
      code: "unsupported_target",
      details: {
        failure_kind: "malformed",
        format: "android-super-image",
        field: "tables_checksum",
      },
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
