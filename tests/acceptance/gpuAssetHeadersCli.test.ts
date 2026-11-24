import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  ddsBc7Fixture,
  glbFixture,
  ktx2Fixture,
  ktxFixture,
} from "../../src/artifacts/gpuAsset/gpuAsset.fixture.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

const cases = [
  {
    format: "dds",
    name: "texture.dds",
    bytes: ddsBc7Fixture(),
    region: "payload.bin",
  },
  {
    format: "glb",
    name: "model.glb",
    bytes: glbFixture(),
    region: "images/0.png",
  },
  {
    format: "ktx",
    name: "texture.ktx",
    bytes: ktxFixture(),
    region: "levels/0.bin",
  },
  {
    format: "ktx2",
    name: "texture.ktx2",
    bytes: ktx2Fixture(),
    region: "levels/0.bin",
  },
] as const;

cliTest.for(cases)(
  "reports $format header facts and extracts its regions through the compiled CLI",
  async ({ format, name, bytes, region }, { cli }) => {
    const directory = await createTestTempDirectory("rea-gpu-asset-cli-");
    const source = join(directory, name);
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
    expect(graph.manifest.root_format).toBe(format);
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({ kind: format, extent_check: "consistent" });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    onTestFinished(() =>
      rm(result.output_root, { recursive: true, force: true }),
    );
    const row = graph.occurrences.find((item) => item.logical_path === region);
    const range = row?.source_location;
    expect(range).toBeDefined();
    expect(
      Buffer.compare(
        await readFile(join(result.output_root, region)),
        bytes.subarray(range!.offset, range!.offset + range!.length),
      ),
    ).toBe(0);
  },
);

cliTest(
  "reports a truncated DDS payload as a size mismatch through the CLI",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-dds-truncated-cli-");
    const source = join(directory, "cut.dds");
    await writeFile(source, ddsBc7Fixture(1000));
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
    expect(graph.coverage.status).toBe("unknown");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "dds",
      payload_bytes: 1000,
      expected_payload_bytes: 65_536,
      extent_check: "truncated",
    });
  },
);

cliTest("refuses a GLB whose first chunk is not JSON", async ({ cli }) => {
  const directory = await createTestTempDirectory("rea-glb-malformed-cli-");
  const source = join(directory, "bad.glb");
  const bytes = glbFixture();
  bytes.write("JSOX", 16, "latin1");
  await writeFile(source, bytes);
  const inspected = await cli.run({
    arguments: ["inspect-artifact", source, "--json"],
  });
  expect(inspected.exitCode).not.toBe(0);
  expect(JSON.stringify(inspected.json)).toContain(
    "the first GLB chunk is not JSON",
  );
});
