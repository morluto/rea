import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  buildDenoSection,
  denoElf,
  denoMachO,
  denoPe,
} from "../../src/artifacts/deno/DenoStandalone.fixture.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contents = "throw new Error('must not execute');\n";

const section = buildDenoSection({
  vfsFileData: Buffer.from(contents),
  vfs: [{ File: { n: "main.ts", o: [0, contents.length], u: true } }],
});

const carriers = [
  ["elf", denoElf(section)],
  ["mach-o", denoMachO(section)],
  ["pe", denoPe([section])],
] as const;

cliTest.for(carriers)(
  "inventories and extracts %s Deno without running it",
  async ([carrier, bytes], { cli }) => {
    const root = await createTestTempDirectory(`rea-deno-cli-${carrier}-`);
    const source = join(root, "app");
    await writeFile(source, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps.find(
        (step) => step.operation === "inventory_artifact",
      )?.evidence.normalized_result,
    );
    expect(graph.manifest.root_format).toBe("deno-standalone");
    expect(inspection.next_probes).toEqual([
      {
        operation: "extract_artifact",
        authority: "artifact-bytes",
        rationale: expect.any(String),
      },
    ]);
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "deno-standalone",
      carrier: carrier === "mach-o" ? "mach-o" : carrier,
      entrypoint_key: "main.ts",
    });
    const module = graph.occurrences.find(
      (row) => row.logical_path === "main.ts",
    );
    expect(
      graph.nodes.find((node) => node.artifact_id === module?.artifact_id)
        ?.sha256,
    ).toBe(createHash("sha256").update(contents).digest("hex"));
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    expect(await readFile(join(result.output_root, "main.ts"), "utf8")).toBe(
      contents,
    );
  },
);
