import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import {
  twoVolumeUbiImage,
  ubiImage,
  ubiLayoutPebs,
  ubiLebData,
  UBI_FIXTURE_KERNEL,
} from "../../src/domain/firmware/ubiImage.fixture.js";

cliTest(
  "inspects and extracts UBI volumes through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ubi-image-cli-");
    const source = join(root, "nand.ubi");
    await writeFile(source, twoVolumeUbiImage());
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    expect(graph.manifest.root_format).toBe("ubi-image");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "ubi-image",
      peb_size: 2048,
      stale_leb_copy_count: 1,
      volumes: [{ name: "kernel" }, { name: "rootfs" }],
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
      (await readFile(join(result.output_root, "volumes/kernel"))).equals(
        UBI_FIXTURE_KERNEL,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(result.output_root, "volumes/rootfs")))
        .subarray(0, 8)
        .toString("latin1"),
    ).toBe("ROOTFS-0");
  },
);

cliTest(
  "inventories a UBI volume with a missing LEB without extracting it",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ubi-image-cli-gap-");
    const source = join(root, "gap.ubi");
    await writeFile(
      source,
      ubiImage([
        ...ubiLayoutPebs([
          { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 4 },
        ]),
        { kind: "leb", volId: 0, lnum: 1, data: ubiLebData(0x31), sqnum: 2n },
      ]),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = inspection.substeps[0]!.evidence.normalized_result;
    expect(
      graph.occurrences.find((row) => row.logical_path === "volumes/rootfs"),
    ).toMatchObject({
      hash_status: "unavailable",
      format_metadata: { missing_leb_count: 1, extractable: false },
    });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode).not.toBe(0);
  },
);
