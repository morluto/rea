import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  gzipTarFixture,
  RELEASE_TAR_MEMBERS,
  tarFixture,
} from "../../src/artifacts/tar/tar.fixture.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

cliTest.for([
  {
    name: "release.tar",
    bytes: tarFixture(RELEASE_TAR_MEMBERS),
    compression: "none",
  },
  {
    name: "release.tar.gz",
    bytes: gzipTarFixture(RELEASE_TAR_MEMBERS),
    compression: "gzip",
  },
] as const)(
  "inventories and extracts $name through the compiled CLI",
  async ({ name, bytes, compression }, { cli }) => {
    const directory = await createTestTempDirectory("rea-tar-cli-");
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
    expect(graph.manifest.root_format).toBe("tar");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({ kind: "tar", compression, end_state: "end-marker" });
    expect(
      graph.occurrences
        .filter((row) => row.entry_kind === "file" && row.logical_path !== ".")
        .map((row) => row.logical_path)
        .sort(),
    ).toEqual(["app/data.pck", "app/run.x86_64"]);
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
    expect(result.containment_verified).toBe(true);
    expect(
      await readFile(join(result.output_root, "app/data.pck"), "utf8"),
    ).toBe("GDPC-not-really");
  },
);

cliTest(
  "reports a truncated tar as partial coverage, not a refusal",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-tar-truncated-cli-");
    const source = join(directory, "cut.tar");
    await writeFile(
      source,
      tarFixture([
        { name: "a.txt", data: "a" },
        { name: "big.bin", data: "x".repeat(2000) },
      ]).subarray(0, 2048),
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
    expect(graph.coverage.status).toBe("unknown");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({ kind: "tar", end_state: "truncated", end_offset: 1024 });
  },
);

cliTest(
  "refuses a tar whose first header fails its checksum with that reason",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-tar-malformed-cli-");
    const source = join(directory, "bad.tar");
    const bytes = tarFixture([{ name: "a.txt", data: "a" }]);
    // The ustar magic stays, so the refusal names the tar header fault.
    bytes[148] = 0x39;
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode).not.toBe(0);
    expect(inspected.json).toMatchObject({
      details: {
        constraint: "file_format_rejected",
        reason: "tar first header checksum does not match",
      },
    });
  },
);
