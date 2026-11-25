import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { pe } from "../../src/domain/binaryTarget.fixture.js";
import { buildIso9660Image } from "../../src/domain/iso9660/iso9660.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

cliTest(
  "inspects and extracts a Joliet ISO 9660 image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-iso9660-cli-");
    const setup = pe(0x14c);
    const readme = Buffer.from("installer readme\n");
    const source = join(root, "installer.iso");
    const { bytes } = buildIso9660Image({
      joliet: true,
      elTorito: true,
      volumeIdentifier: "INSTALLER",
      files: [
        { path: "README.TXT", bytes: readme },
        {
          path: "bin/setup.exe",
          bytes: setup,
          primaryIdentifier: "SETUP.EXE;1",
        },
      ],
    });
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.manifest.root_format).toBe("iso9660");
    // Joliet names are walked; the primary tree is not, so coverage is open.
    expect(graph.coverage.status).toBe("unknown");
    expect(graph.limitations.join(" ")).toContain("The primary directory tree");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "iso9660",
      volume_identifier: "INSTALLER",
      joliet_level: 3,
      name_source: "joliet",
      el_torito_boot_record: true,
      file_count: 2,
      directory_count: 1,
    });
    expect(
      graph.occurrences.find((row) => row.logical_path === "bin/setup.exe"),
    ).toMatchObject({ artifact_format: "pe", hash_status: "verified" });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    expect(
      sha256(await readFile(join(result.output_root, "bin/setup.exe"))),
    ).toBe(sha256(setup));
    expect(sha256(await readFile(join(result.output_root, "README.TXT")))).toBe(
      sha256(readme),
    );
    expect((await readFile(source)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "reports a malformed ISO 9660 directory tree through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-iso9660-cli-malformed-");
    const { bytes, layout } = buildIso9660Image({
      files: [{ path: "dir/a.txt", bytes: Buffer.from("a") }],
    });
    const record = layout.primaryRecords.get("dir")!;
    bytes.writeUInt32LE(layout.directoryBlocks.get("")!, record + 2);
    bytes.writeUInt32BE(layout.directoryBlocks.get("")!, record + 6);
    const path = join(root, "cycle.iso");
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      retryable: false,
      retry: "none",
      details: {
        operation: "inspect_artifact",
        path,
        failure_kind: "malformed",
        format: "iso9660",
        field: "extent_location",
      },
    });
  },
);
