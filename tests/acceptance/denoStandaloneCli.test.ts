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
import { peResourceFixture } from "../../src/domain/pe/peResources.fixture.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { expectCarrierProbes } from "../fixtures/nativeCarrierProbes.js";
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
    // The carrier's own readers follow the package reader.
    expectCarrierProbes(inspection.next_probes, carrier, ["extract_artifact"]);
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

cliTest(
  "distinguishes the fixed Deno PE entry allowance from malformed framing",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-deno-pe-entry-allowance-");
    const payload = Buffer.from("opaque");
    const fixture = peResourceFixture(
      true,
      Array.from({ length: 65_535 }, (_, language) => ({
        type: 10,
        name: "D3N0L4ND",
        language,
        payload,
      })),
      3 * 1024 * 1024,
    );
    const path = join(root, "large-table.exe");
    await writeFile(path, fixture.bytes);
    const capped = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(capped.exitCode).toBe(1);
    expect(capped.json).toMatchObject({
      code: "partial",
      details: {
        reason: "limit",
        boundary: "capacity",
        reported_limits: { maximum: 65_536, required: 65_537 },
      },
    });

    // The language directory declares one more row than the admitted interval holds.
    const [resourceRoot, , languages] = fixture.directoryOffsets;
    if (resourceRoot === undefined || languages === undefined)
      throw new Error("Missing resource fixture directories");
    fixture.bytes.writeUInt32LE(
      languages - resourceRoot + 16 + 65_535 * 8 - 1,
      fixture.directoryAt + 4,
    );
    await writeFile(path, fixture.bytes);
    const malformed = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.json).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      details: { path, failure_kind: "malformed" },
    });
  },
);
