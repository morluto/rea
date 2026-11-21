import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { sha256Hex } from "../../src/kernel/sha256Hex.js";
import {
  SAMPLE_PUBLIC_KEY,
  SAMPLE_PUBLIC_KEY_METADATA,
  androidVbmetaRefusals,
  sampleAndroidVbmeta,
} from "../../src/domain/firmware/androidVbmeta.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "inspects and extracts a vbmeta image through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-android-vbmeta-cli-");
    const source = join(root, "vbmeta.img");
    const callerPath = `${root}/./vbmeta.img`;
    const bytes = sampleAndroidVbmeta();
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", callerPath, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const evidence = parseEvidence(inspected.json);
    expect(evidence.caller_input_path).toBe(callerPath);
    const inspection = artifactInspectionResultSchema.parse(
      evidence.normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.manifest.root_format).toBe("android-vbmeta");
    expect(graph.coverage.status).toBe("complete");
    const rootMetadata = graph.occurrences.find(
      (row) => row.logical_path === ".",
    )?.format_metadata;
    expect(rootMetadata).toMatchObject({
      kind: "android-vbmeta",
      algorithm_name: "SHA256_RSA2048",
      flag_names: ["HASHTREE_DISABLED", "VERIFICATION_DISABLED"],
      release_string: "avbtool 1.2.0",
      signatures_verified: false,
      public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
    });
    expect(
      rootMetadata?.kind === "android-vbmeta" &&
        rootMetadata.descriptors.map((descriptor) => descriptor.tag_name),
    ).toEqual([
      "PROPERTY",
      "HASHTREE",
      "HASH",
      "KERNEL_CMDLINE",
      "CHAIN_PARTITION",
      "UNKNOWN",
    ]);
    const descriptors =
      rootMetadata?.kind === "android-vbmeta" ? rootMetadata.descriptors : [];
    expect(descriptors[1]).toMatchObject({
      tag_name: "HASHTREE",
      image_size: "409600",
      tree_offset: "409600",
      tree_size: "4096",
      fec_offset: "413696",
      fec_size: "4096",
    });
    expect(descriptors[2]).toMatchObject({
      tag_name: "HASH",
      image_size: "32768",
    });
    expect(rootMetadata).toMatchObject({ rollback_index: expect.any(String) });
    expect(descriptors[5]).toMatchObject({
      tag_name: "UNKNOWN",
      tag: expect.any(String),
    });
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        callerPath,
        "--output-root",
        join(root, "extracted"),
        "--json",
      ],
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    expect(
      (await readFile(join(result.output_root, "public_key"))).equals(
        SAMPLE_PUBLIC_KEY,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(result.output_root, "public_key_metadata"))).equals(
        SAMPLE_PUBLIC_KEY_METADATA,
      ),
    ).toBe(true);
    expect(
      sha256Hex(await readFile(join(result.output_root, "public_key"))),
    ).toBe(
      rootMetadata?.kind === "android-vbmeta"
        ? rootMetadata.public_key_sha256
        : undefined,
    );
  },
);

for (const fixture of androidVbmetaRefusals()) {
  cliTest(
    `keeps the Android vbmeta refusal for ${fixture.name} through the compiled CLI`,
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-android-vbmeta-cli-refusals-",
      );
      const path = join(root, `${fixture.name}.img`);
      await writeFile(path, fixture.bytes);
      const result = await cli.run({
        arguments: ["inspect-artifact", path, "--json"],
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(1);
      expect(result.json, fixture.name).toMatchObject({
        code: fixture.code,
        category: fixture.category,
        details: { operation: "inspect_artifact", reason: fixture.kind },
      });
      expect((await readFile(path)).equals(fixture.bytes)).toBe(true);
    },
  );
}
