import { createOwnedArtifactClient } from "../../../support/artifactClientScope.js";
import { projectCliAnalysisResult } from "../../../../src/cli/projectCliAnalysisResult.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage, createPackageWithOptions } from "@electron/asar";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

const { runProviderAnalysis } = createDirectAnalysis({});

describe("artifact archive inventory", () => {
  it("returns complete ZIP and official ASAR inventories inline", async () => {
    const root = await createTestTempDirectory("rea-containers-");
    const zipPath = join(root, "fixture.apk");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add("assets/index.js", new TextReader("export default 1;"));
    await zipWriter.add("lib/arm64-v8a/addon.so", new TextReader("native"));
    await writeFile(zipPath, await zipWriter.close());
    const parsed = await parseBinaryTarget(zipPath);
    expect(parsed.ok && parsed.value.format).toBe("apk");
    if (!parsed.ok) return;
    const zipResult = await inventory(parsed.value);
    expect(zipResult.occurrences.length).toBe(3);
    expect(
      zipResult.occurrences.map(({ artifact_kind }) => artifact_kind),
    ).toEqual(expect.arrayContaining(["javascript", "dynamic-library"]));
    const cliEvidence = parseEvidence(
      await runProviderAnalysis(zipPath, "inventory_artifact", {}).then(
        projectCliAnalysisResult,
      ),
    );
    expect(cliEvidence).toMatchObject({
      operation: "inventory_artifact",
      provider: { id: "rea-artifact-graph" },
      subject: { identity: { format: "apk" } },
    });
    const inspectionEvidence = parseEvidence(
      await runProviderAnalysis(zipPath, "inspect_artifact", {}).then(
        projectCliAnalysisResult,
      ),
    );
    const inspection = artifactInspectionResultSchema.parse(
      inspectionEvidence.normalized_result,
    );
    expect(inspection).toMatchObject({
      substeps: [
        {
          operation: "inventory_artifact",
          status: "completed",
          evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        },
      ],
      coverage: { status: "complete-within-substeps", substeps_completed: 1 },
    });
    expect(inspectionEvidence.evidence_links).toEqual(
      inspection.evidence_links,
    );
    // The graph is delivered once, in the nested inventory Evidence.
    expect(
      artifactInventoryResultSchema.parse(
        inspection.substeps[0]?.evidence.normalized_result,
      ).occurrences,
    ).toHaveLength(3);
    // Occurrences name every logical path; neither Evidence repeats them.
    expect(inspectionEvidence.locations).toEqual([]);
    expect(inspection.substeps[0]?.evidence.locations).toEqual([]);
    expect(inspection.observations.map(({ kind }) => kind)).toEqual([
      "root-manifest",
    ]);
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      runProviderAnalysis(
        zipPath,
        "inventory_artifact",
        {},
        undefined,
        cancellation.signal,
      ).then(projectCliAnalysisResult),
    ).resolves.toMatchObject({ code: "cancelled" });
    await expect(
      runProviderAnalysis(
        zipPath,
        "inspect_artifact",
        {},
        undefined,
        cancellation.signal,
      ).then(projectCliAnalysisResult),
    ).resolves.toMatchObject({ code: "cancelled" });

    const source = join(root, "asar-source");
    await mkdir(source);
    await writeFile(join(source, "main.js"), "console.log('ok');\n");
    const asarPath = join(root, "app.asar");
    await createPackage(source, asarPath);
    const asarResult = await inventory(await target(asarPath));
    expect(asarResult.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_path: "main.js" }),
      ]),
    );

    const unpackedPath = join(root, "unpacked.asar");
    await createPackageWithOptions(source, unpackedPath, { unpack: "*.js" });
    const unpackedResult = await inventory(await target(unpackedPath));
    expect(unpackedResult.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "main.js",
          hash_status: "verified",
        }),
      ]),
    );
    await writeFile(
      join(`${unpackedPath}.unpacked`, "main.js"),
      "changed();\n",
    );
    const corrupted = await createOwnedArtifactClient(
      await target(unpackedPath),
    ).execute("inventory_artifact", {});
    expect(corrupted).toMatchObject({
      ok: false,
      error: {
        _tag: "ArtifactOperationError",
        reason: "integrity",
        artifactDetails: {
          logicalPath: "main.js",
          unpacked: true,
        },
      },
    });
    const failedInspection = await createOwnedArtifactClient(
      await target(unpackedPath),
    ).execute("inspect_artifact", {});
    expect(failedInspection).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "integrity" },
    });
  });
});

describe("artifact member architecture", () => {
  // A ZIP of x86-64 Linux plugin libraries reported null for every member.
  it("records the architecture each member's executable header declares", async () => {
    const root = await createTestTempDirectory("rea-member-architecture-");
    const zipPath = join(root, "plugin.zip");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add(
      "lib/libcore.so",
      new Uint8ArrayReader(elfHeader(0x3e)),
    );
    await zipWriter.add(
      "lib/aarch64/libcore.so",
      new Uint8ArrayReader(elfHeader(0xb7)),
    );
    await zipWriter.add("lib/stub.so", new TextReader("not an ELF image"));
    await writeFile(zipPath, await zipWriter.close());
    const parsed = await parseBinaryTarget(zipPath);
    if (!parsed.ok) throw new Error("Expected a ZIP target");
    const result = await inventory(parsed.value);
    const architectureAt = (logicalPath: string) => {
      const occurrence = result.occurrences.find(
        ({ logical_path }) => logical_path === logicalPath,
      );
      return result.nodes.find(
        ({ artifact_id }) => artifact_id === occurrence?.artifact_id,
      )?.architecture;
    };
    expect(architectureAt("lib/libcore.so")).toBe("x86_64");
    expect(architectureAt("lib/aarch64/libcore.so")).toBe("arm64");
    expect(architectureAt("lib/stub.so")).toBeNull();
    expect(architectureAt(".")).toBeNull();
  });

  it("names a universal Mach-O container's CPU only when it holds one agreeing slice", async () => {
    const root = await createTestTempDirectory("rea-universal-architecture-");
    const oneSlice = fatImage([
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
    ]);
    const twoSlices = fatImage([
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
    ]);
    // The table declares arm64 but the slice's own header declares x86-64.
    const disagreeing = fatImage([
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.x86_64 }) },
    ]);
    const zipPath = join(root, "frameworks.zip");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add("one.dylib", new Uint8ArrayReader(oneSlice));
    await zipWriter.add("two.dylib", new Uint8ArrayReader(twoSlices));
    await zipWriter.add("disagreeing.dylib", new Uint8ArrayReader(disagreeing));
    await writeFile(zipPath, await zipWriter.close());
    const onePath = join(root, "one.dylib");
    await writeFile(onePath, oneSlice);
    const members = await inventory(await target(zipPath));
    const standalone = await inventory(await target(onePath));
    const nodeAt = (
      result: typeof members,
      logicalPath: string,
    ): (typeof members)["nodes"][number] | undefined => {
      const occurrence = result.occurrences.find(
        ({ logical_path }) => logical_path === logicalPath,
      );
      return result.nodes.find(
        ({ artifact_id }) => artifact_id === occurrence?.artifact_id,
      );
    };
    expect(nodeAt(members, "one.dylib")).toMatchObject({
      format: "mach-o-universal",
      architecture: "arm64",
    });
    expect(nodeAt(members, "two.dylib")).toMatchObject({
      format: "mach-o-universal",
      architecture: null,
    });
    expect(nodeAt(standalone, ".")).toMatchObject({
      format: "mach-o-universal",
      architecture: "arm64",
    });
    // Target resolution refuses such an image as a root; as a member it is
    // still inventoried, without a CPU.
    expect(nodeAt(members, "disagreeing.dylib")).toMatchObject({
      format: "mach-o-universal",
      architecture: null,
    });
  });

  it("names 32-bit PowerPC as Evidence's powerpc family and leaves 64-bit PowerPC unnamed", async () => {
    const root = await createTestTempDirectory("rea-powerpc-architecture-");
    const ppc = { type: 18, subtype: 0 };
    const ppc64 = { type: 0x01000012, subtype: 0 };
    const zipPath = join(root, "powerpc.zip");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add(
      "ppc.dylib",
      new Uint8ArrayReader(machoImage({ cpu: ppc, wide: false })),
    );
    await zipWriter.add(
      "ppc-universal.dylib",
      new Uint8ArrayReader(
        fatImage([{ cpu: ppc, bytes: machoImage({ cpu: ppc, wide: false }) }]),
      ),
    );
    await zipWriter.add(
      "ppc64.dylib",
      new Uint8ArrayReader(machoImage({ cpu: ppc64 })),
    );
    await zipWriter.add(
      "ppc.so",
      new Uint8ArrayReader(elf32BigEndianHeader(20)),
    );
    await zipWriter.add(
      "ppc64.so",
      new Uint8ArrayReader(elf64BigEndianHeader(21)),
    );
    await writeFile(zipPath, await zipWriter.close());
    const result = await inventory(await target(zipPath));
    const nodeAt = (logicalPath: string) => {
      const occurrence = result.occurrences.find(
        ({ logical_path }) => logical_path === logicalPath,
      );
      return result.nodes.find(
        ({ artifact_id }) => artifact_id === occurrence?.artifact_id,
      );
    };
    expect(nodeAt("ppc.dylib")).toMatchObject({
      format: "mach-o",
      architecture: "powerpc",
    });
    expect(nodeAt("ppc-universal.dylib")).toMatchObject({
      format: "mach-o-universal",
      architecture: "powerpc",
    });
    expect(nodeAt("ppc.so")).toMatchObject({
      format: "elf",
      architecture: "powerpc",
    });
    // Evidence has no 64-bit PowerPC family.
    expect(nodeAt("ppc64.dylib")).toMatchObject({ architecture: null });
    expect(nodeAt("ppc64.so")).toMatchObject({ architecture: null });
  });
});

/** Minimal ELF32 big-endian header with the selected e_machine value. */
const elf32BigEndianHeader = (machine: number): Uint8Array => {
  const header = Buffer.alloc(52);
  header.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]);
  header.writeUInt16BE(3, 16);
  header.writeUInt16BE(machine, 18);
  header.writeUInt32BE(1, 20);
  header.writeUInt16BE(52, 40);
  return new Uint8Array(header);
};

/** Minimal ELF64 big-endian header with the selected e_machine value. */
const elf64BigEndianHeader = (machine: number): Uint8Array => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 2, 1]);
  header.writeUInt16BE(3, 16);
  header.writeUInt16BE(machine, 18);
  header.writeUInt32BE(1, 20);
  header.writeUInt16BE(64, 52);
  return new Uint8Array(header);
};

/** Minimal ELF64 little-endian header with the selected e_machine value. */
const elfHeader = (machine: number): Uint8Array => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(machine, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return new Uint8Array(header);
};

const inventory = async (targetValue: BinaryTarget) => {
  const result = await createOwnedArtifactClient(targetValue).execute(
    "inventory_artifact",
    {},
  );
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};

const target = async (path: string): Promise<BinaryTarget> => {
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
