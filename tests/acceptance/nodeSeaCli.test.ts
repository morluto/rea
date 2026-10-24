import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  nodeSeaElf,
  nodeSeaMachO,
  nodeSeaPe,
} from "../../src/artifacts/nodeSea/NodeSea.fixture.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

cliTest.for(["elf", "mach-o", "pe"] as const)(
  "inventories and extracts %s SEA through the compiled CLI",
  async (carrier, { cli }) => {
    const root = await createTestTempDirectory("rea-sea-cli-");
    const source = join(root, "application");
    const build = { elf: nodeSeaElf, "mach-o": nodeSeaMachO, pe: nodeSeaPe }[
      carrier
    ];
    const script = 'throw new Error("must not execute");\n';
    await writeFile(
      source,
      build({
        codePath: "main.js",
        main: script,
        fuse: "unset",
        assets: [{ name: "data/hello.txt", body: "hello" }],
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
    expect(graph.manifest.root_format).toBe("node-sea");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "node-sea",
      carrier,
      fuse_state: "unset",
      include_assets: true,
    });
    expect(graph.limitations.join(" ")).toContain("sentinel is unset");
    expect(
      graph.occurrences.find((row) => row.logical_path === "main.js"),
    ).toMatchObject({
      artifact_format: "javascript-bundle",
      hash_status: "verified",
    });
    expect(inspection.next_probes.map((probe) => probe.operation)).toContain(
      "analyze_javascript_application",
    );
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    expect(await readFile(join(result.output_root, "main.js"), "utf8")).toBe(
      script,
    );
    expect(
      await readFile(join(result.output_root, "data/hello.txt"), "utf8"),
    ).toBe("hello");
  },
);

cliTest(
  "offers no JavaScript probe for a main script without a source suffix",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sea-plain-cli-");
    const source = join(root, "application");
    await writeFile(
      source,
      nodeSeaElf({ codePath: "main", main: "void 0;\n", fuse: "set" }),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    expect(
      inspection.next_probes.map((probe) => probe.operation),
    ).not.toContain("analyze_javascript_application");
  },
);

cliTest("rejects a malformed SEA blob through the CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-sea-invalid-cli-");
  const source = join(root, "application");
  await writeFile(source, nodeSeaElf({ blob: Buffer.alloc(16) }));
  const result = await cli.run({
    arguments: ["inspect-artifact", source, "--json"],
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("Node SEA blob magic");
});
