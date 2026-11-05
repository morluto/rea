import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  CPU,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import {
  createOwnedArtifactClient,
  withArtifactClient,
} from "../../../support/artifactClientScope.js";
import { registerArtifactCommands } from "../../../../src/cli/artifactCommands.js";
import type { CliInstance } from "../../../../src/cli/types.js";
import type { DirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { ok } from "../../../../src/domain/result.js";
import pino from "pino";

describe("artifact extraction", () => {
  it.skipIf(process.platform === "win32").each(["file/..", "missing"])(
    "refuses an invalid parent (%s) before acquiring output and permits a corrected request",
    async (parent) => {
      const root = await createTestTempDirectory("rea-extract-invalid-parent-");
      const source = join(root, "source.app");
      await mkdir(source);
      await writeFile(join(source, "payload.txt"), "selected payload\n");
      await writeFile(join(root, "file"), "parent is a file");
      const output = join(root, "out");

      await withArtifactClient(await target(source), async (client) => {
        const refused = await client.execute("extract_artifact", {
          output_root: `${root}/${parent}/out`,
        });
        expect(refused).toMatchObject({
          ok: false,
          error: { _tag: "ArtifactOperationError", reason: "path" },
        });
        if (!refused.ok) expect(refused.error.cleanupIncomplete).toBe(false);
        await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });

        const corrected = await client.execute("extract_artifact", {
          output_root: output,
        });
        if (!corrected.ok) throw corrected.error;
        expect(
          artifactExtractionResultSchema.parse(corrected.value.result),
        ).toMatchObject({ output_root: output, containment_verified: true });
        expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
          "selected payload\n",
        );
      });
    },
  );

  it("keeps committed files after the owning client closes", async () => {
    const root = await createTestTempDirectory("rea-extract-client-close-");
    const source = join(root, "source.app");
    await mkdir(source);
    await writeFile(join(source, "payload.txt"), "committed\n");
    const output = join(root, "output");
    const client = createOwnedArtifactClient(await target(source));

    const result = await client.execute("extract_artifact", {
      output_root: output,
    });
    if (!result.ok) throw result.error;
    expect((await client.close()).ok).toBe(true);
    expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
      "committed\n",
    );
  });

  it("extracts all regular occurrences through an exclusively owned output tree", async () => {
    const root = await createTestTempDirectory("rea-extract-");
    const source = join(root, "source.app");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets", "selected.js"), "selected();\n");
    await writeFile(join(source, "assets", "ignored.js"), "ignored();\n");
    const targetValue = await target(source);
    const graph = await inventory(targetValue);
    expect(
      graph.occurrences.some(
        ({ logical_path }) => logical_path === "assets/selected.js",
      ),
    ).toBe(true);
    const cancelledOutput = join(root, "cancelled-output");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await createOwnedArtifactClient(targetValue).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: cancelledOutput,
      }),
      { signal: controller.signal },
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(cancelledOutput)).rejects.toThrow();
    const output = join(root, "output");
    const result = await createOwnedArtifactClient(targetValue).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: output,
      }),
    );
    if (!result.ok) throw result.error;
    const firstExtraction = artifactExtractionResultSchema.parse(
      result.value.result,
    );
    expect(firstExtraction).toMatchObject({
      output_root: output,
      containment_verified: true,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ relative_path: "assets/selected.js" }),
      ]),
      extraction_manifest: { output_root_alias: "$OUTPUT_ROOT" },
    });
    // artifacts names every extracted path; the Evidence does not repeat them.
    expect(result.value.locations).toEqual([]);
    expect(await readFile(join(output, "assets", "selected.js"), "utf8")).toBe(
      "selected();\n",
    );
    expect(await readFile(join(output, "assets", "ignored.js"), "utf8")).toBe(
      "ignored();\n",
    );

    const relocatedOutput = join(root, "relocated-output");
    const relocated = await createOwnedArtifactClient(targetValue).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: relocatedOutput,
      }),
    );
    if (!relocated.ok) throw relocated.error;
    expect(
      artifactExtractionResultSchema.parse(relocated.value.result)
        .extraction_manifest,
    ).toEqual(firstExtraction.extraction_manifest);

    const second = await createOwnedArtifactClient(targetValue).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: output,
      }),
    );
    expect(second).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
    expect((await readdir(root)).sort()).toEqual([
      "output",
      "relocated-output",
      "source.app",
    ]);
  });
});

describe("artifact extraction dry-run", () => {
  it("supports dry_run extraction planning and refuses existing destinations without creating files", async () => {
    const root = await createTestTempDirectory("rea-extract-dry-run-boundary-");
    const source = join(root, "source.app");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "item.txt"), "hello world\n");
    const targetValue = await target(source);
    const plannedOutput = join(root, "planned-output");

    const dryResult = await createOwnedArtifactClient(targetValue).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: plannedOutput,
        dry_run: true,
      }),
    );
    if (!dryResult.ok) throw dryResult.error;
    const parsedDry = artifactExtractionResultSchema.parse(
      dryResult.value.result,
    );
    expect(parsedDry.dry_run).toBe(true);
    expect(parsedDry.artifacts).toEqual([
      expect.objectContaining({
        relative_path: "Info.plist",
        bytes_written: 0,
        created: false,
      }),
      expect.objectContaining({
        relative_path: "Main",
        bytes_written: 0,
        created: false,
      }),
      expect.objectContaining({
        relative_path: "nested/item.txt",
        bytes_written: 0,
        created: false,
      }),
    ]);
    expect(parsedDry.plan).toMatchObject({
      entries: [
        expect.objectContaining({
          logical_path: "Info.plist",
          entry_kind: "file",
          status: "planned",
        }),
        expect.objectContaining({
          logical_path: "Main",
          entry_kind: "file",
          status: "planned",
        }),
        expect.objectContaining({
          logical_path: "nested",
          entry_kind: "directory",
          status: "unsupported",
        }),
        expect.objectContaining({
          logical_path: "nested/item.txt",
          entry_kind: "file",
          status: "planned",
          observed_bytes: 12,
          declared_bytes: 12,
        }),
      ],
      totals: {
        planned_files: 3,
        unsupported_entries: 1,
        unresolved_entries: 0,
        byte_totals_basis: "declared-and-observed-content-estimates",
      },
    });
    await expect(access(plannedOutput)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["source.app"]);

    await mkdir(plannedOutput);
    const existingRefusal = await createOwnedArtifactClient(
      targetValue,
    ).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: plannedOutput,
        dry_run: true,
      }),
    );
    expect(existingRefusal).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
  });
});

describe("artifact extraction dry-run CLI", () => {
  it("exposes --plan-offset and --plan-limit on CLI extract-artifact and requires --dry-run", async () => {
    const source = "/tmp/fake-source.app";
    const registeredCommands = new Map<
      string,
      {
        run: (context: {
          args: { path: string };
          options: {
            integrityPolicy: "fail" | "record-and-continue";
            dryRun: boolean;
            planOffset?: number;
            planLimit?: number;
          };
        }) => Promise<unknown>;
      }
    >();
    const fakeCli = {
      command: (name: string, definition: { run: unknown }) => {
        registeredCommands.set(name, definition as never);
      },
    } as unknown as CliInstance;
    const providerCalls: {
      path: string;
      operation: string;
      params: unknown;
    }[] = [];
    registerArtifactCommands(fakeCli, pino({ level: "silent" }), (async (
      targetPath: string,
      operation: string,
      params: unknown,
    ) => {
      providerCalls.push({ path: targetPath, operation, params });
      return ok({} as never);
    }) as unknown as DirectAnalysis["runProviderAnalysis"]);
    const extractCmd = registeredCommands.get("extract-artifact");
    expect(extractCmd).toBeDefined();

    const rejectedWithoutDryRun = await extractCmd!.run({
      args: { path: source },
      options: {
        integrityPolicy: "fail",
        dryRun: false,
        planOffset: 10,
      },
    });
    expect(providerCalls).toHaveLength(0);
    expect(rejectedWithoutDryRun).toMatchObject({
      category: "invalid_input",
      code: "invalid_request",
      details: {
        operation: "extract_artifact",
        issues: [
          {
            path: ["plan_offset"],
            message: "plan_offset requires dry_run=true.",
          },
        ],
      },
    });

    await extractCmd!.run({
      args: { path: source },
      options: {
        integrityPolicy: "fail",
        dryRun: true,
        planOffset: 10,
        planLimit: 25,
      },
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      path: source,
      operation: "extract_artifact",
      params: {
        integrity_policy: "fail",
        dry_run: true,
        plan_offset: 10,
        plan_limit: 25,
      },
    });
  });
});
const inventory = async (targetValue: BinaryTarget) => {
  const result = await createOwnedArtifactClient(targetValue).execute(
    "inventory_artifact",
    {},
  );
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};

/** A real bundle target has an executable identity distinct from its resource tree. */
const target = async (path: string): Promise<BinaryTarget> => {
  await writeFile(
    join(path, "Info.plist"),
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Main</string></dict></plist>',
  );
  await writeFile(join(path, "Main"), machoImage({ cpu: CPU.arm64 }));
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.bundleInfoPlist).toBe(join(path, "Info.plist"));
  return parsed.value;
};
