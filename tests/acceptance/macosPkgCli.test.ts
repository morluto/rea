import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import {
  buildProductArchive,
  truncatedPkgHeader,
} from "../../src/artifacts/macosPkg/MacosPkg.fixture.js";

cliTest(
  "inspects and extracts a macOS flat installer package through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-macos-pkg-cli-");
    const source = join(root, "fixture.pkg");
    const bytes = buildProductArchive();
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
    expect(graph.manifest.root_format).toBe("pkg");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "macos-pkg",
      archive_kind: "product",
      scripts: { preinstall: true, postinstall: true },
      signature: { verification: "not_verified" },
    });
    const hello = graph.occurrences.find(
      (row) =>
        row.logical_path === "Component.pkg/Payload/usr/local/rea/hello.txt",
    );
    expect(hello).toMatchObject({
      format_metadata: expect.objectContaining({ role: "payload-member" }),
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
    const payload = Buffer.from("hello from payload\n");
    expect(
      (
        await readFile(
          join(
            result.output_root,
            "Component.pkg/Payload/usr/local/rea/hello.txt",
          ),
        )
      ).equals(payload),
    ).toBe(true);
    expect(createHash("sha256").update(payload).digest("hex")).toBe(
      result.artifacts.find(
        (row) =>
          row.relative_path === "Component.pkg/Payload/usr/local/rea/hello.txt",
      )?.sha256,
    );
    const malformed = join(root, "truncated.pkg");
    await writeFile(malformed, truncatedPkgHeader());
    const refused = await cli.run({
      arguments: ["inspect-artifact", malformed, "--json"],
    });
    expect(refused.exitCode, refused.stdout + refused.stderr).toBe(0);
    const refusedGraph = artifactInventoryResultSchema.parse(
      artifactInspectionResultSchema.parse(
        parseEvidence(refused.json).normalized_result,
      ).substeps[0]?.evidence.normalized_result,
    );
    expect(refusedGraph.coverage.status).toBe("unknown");
    expect(refusedGraph.occurrences[0]?.format_metadata).toMatchObject({
      kind: "macos-pkg",
      refusals: [expect.objectContaining({ code: "truncated-header" })],
    });
  },
);
