import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { expectCarrierProbes } from "../fixtures/nativeCarrierProbes.js";
import {
  bunModuleGraphPayload,
  bunPrefixedPayload,
  machoBunSection,
  machoBunSections,
  elfAppendedBunPayload,
} from "../../src/artifacts/bun/BunStandalone.fixture.js";
import { DEFAULT_BUN_READER_LIMITS } from "../../src/domain/artifactReaderLimits.js";
import { CPU_ARM64, universalMacho } from "../fixtures/universalMacho.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactInventoryResultSchema,
  artifactExtractionResultSchema,
} from "../../src/domain/artifactGraph.js";

cliTest(
  "does not resolve Bun layout ambiguity by lowering the module budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bun-layout-ambiguity-");
    const path = join(root, "app");
    await writeFile(
      path,
      elfAppendedBunPayload(
        bunModuleGraphPayload({
          modules: [{ loader: 0, moduleFormat: 0 }],
          tableLength: 468,
        }),
      ),
    );
    for (const moduleCount of [9, 13]) {
      const result = await cli.run({
        arguments: [
          "inspect-artifact",
          path,
          "--artifact-limits",
          JSON.stringify({ bun: { module_count: moduleCount } }),
          "--json",
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: moduleCount < 13 ? "partial" : "artifact_operation_failed",
        retryable: moduleCount < 13,
        details:
          moduleCount < 13
            ? {
                reason: "limit",
                reader_limit: {
                  parameter: "artifact_limits.bun.module_count",
                  effective_value: moduleCount,
                  required_value: 13,
                },
              }
            : { reason: "unavailable" },
      });
    }
  },
);

cliTest(
  "distinguishes a truncated Bun graph from an intact graph over the selected limit",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bun-payload-extent-");
    const source = join(root, "app");
    const payload = bunModuleGraphPayload({ modules: [{ name: "main.js" }] });
    const section = bunPrefixedPayload(payload);
    const limits = JSON.stringify({
      bun: { payload_bytes: payload.length - 1 },
    });
    const inspect = async () => {
      await writeFile(source, machoBunSection(section));
      const result = await cli.run({
        arguments: [
          "inspect-artifact",
          source,
          "--artifact-limits",
          limits,
          "--json",
        ],
      });
      expect(result.exitCode, result.stderr).toBe(1);
      return result.json;
    };
    expect(await inspect()).toMatchObject({
      retryable: true,
      details: {
        reason: "limit",
        reader_limit: {
          parameter: "artifact_limits.bun.payload_bytes",
          effective_value: payload.length - 1,
          required_value: payload.length,
        },
      },
    });
    section.writeBigUInt64LE(BigInt(payload.length + 1));
    expect(await inspect()).toMatchObject({
      code: "unsupported_target",
      retryable: false,
      retry: "none",
      details: {
        path: source,
        failure_kind: "truncated",
        format: "bun-standalone",
      },
    });
  },
);

cliTest(
  "reports large Bun section ambiguity through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bun-many-sections-");
    const source = join(root, "app");
    const graph = bunPrefixedPayload(bunModuleGraphPayload({ modules: [{}] }));
    const thin = machoBunSections(Array.from({ length: 200_000 }, () => graph));
    expect(thin.readUInt32LE(20)).toBeLessThanOrEqual(
      DEFAULT_BUN_READER_LIMITS.recognition_load_command_bytes,
    );
    const fat = universalMacho([
      { bytes: thin, cpuType: CPU_ARM64, cpuSubtype: 0 },
    ]);
    await writeFile(source, fat.bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(1);
    expect(inspected.json).toMatchObject({
      code: "artifact_operation_failed",
      category: "unavailable",
      details: {
        reason: "unavailable",
        detail: expect.stringContaining("multiple embedded graphs"),
      },
    });
  },
);

cliTest(
  "inventories and extracts Bun source from its carrier",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bun-cli-");
    const source = join(root, "app");
    const contents = "console.log('Bun fixture');\n";
    await writeFile(
      source,
      elfAppendedBunPayload(
        bunModuleGraphPayload({
          modules: [
            {
              name: "/$bunfs/root/main.js",
              contents: Buffer.from(contents),
              sourcemap: Buffer.from("map"),
              bytecode: Buffer.from([1, 2]),
            },
          ],
        }),
      ),
    );
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
    expect(graph.manifest.root_format).toBe("bun-standalone");
    // The ELF carrier's readers follow the package reader.
    expectCarrierProbes(inspection.next_probes, "elf", ["extract_artifact"]);
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "bun-standalone",
      entry_point_id: 0,
      entry_point_logical_path: "$bunfs/root/main.js",
    });
    const module = graph.occurrences.find(
      (row) => row.logical_path === "$bunfs/root/main.js",
    );
    expect(
      graph.nodes.find((node) => node.artifact_id === module?.artifact_id)
        ?.sha256,
    ).toBe(createHash("sha256").update(contents).digest("hex"));
    expect(module).toMatchObject({
      format_metadata: {
        entry_point: true,
        source_name: "/$bunfs/root/main.js",
        sourcemap_bytes: 3,
        bytecode_bytes: 2,
      },
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
      await readFile(join(result.output_root, "$bunfs/root/main.js"), "utf8"),
    ).toBe(contents);
  },
);
