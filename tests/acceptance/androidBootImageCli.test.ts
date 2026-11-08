import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { buildVendorBootImage } from "../fixtures/androidBootImage.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inspects and extracts a vendor_boot image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-boot-cli-");
    const platform = Buffer.from("platform-bytes");
    const recovery = Buffer.from("recovery-bytes");
    const dtb = Buffer.from("vendor-dtb");
    const bootconfig = Buffer.from("androidboot.hardware=test\n");
    const source = join(root, "vendor_boot.img");
    await writeFile(
      source,
      buildVendorBootImage({
        version: 4,
        name: "board",
        cmdline: "console=tty0",
        ramdisks: [
          { name: "platform", type: 1, bytes: platform },
          { name: "recovery", type: 2, bytes: recovery },
        ],
        dtb,
        bootconfig,
      }),
    );
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
    expect(graph.manifest.root_format).toBe("android-boot-image");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-boot-image",
      image_kind: "vendor-boot",
      magic: "VNDRBOOT",
      header_version: 4,
      name: "board",
      command_line: "console=tty0",
      vendor_ramdisk_table_entry_count: 2,
      component_count: 4,
    });
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
      (
        await readFile(join(result.output_root, "vendor_ramdisk/platform"))
      ).equals(platform),
    ).toBe(true);
    expect(
      (
        await readFile(join(result.output_root, "vendor_ramdisk/recovery"))
      ).equals(recovery),
    ).toBe(true);
    expect((await readFile(join(result.output_root, "dtb"))).equals(dtb)).toBe(
      true,
    );
    expect(
      (await readFile(join(result.output_root, "bootconfig"))).equals(
        bootconfig,
      ),
    ).toBe(true);
  },
);
