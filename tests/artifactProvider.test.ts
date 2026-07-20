import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackage, createPackageWithOptions } from "@electron/asar";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { ArtifactProvider } from "../src/artifacts/ArtifactProvider.js";
import { MachOSliceArtifactReader } from "../src/artifacts/MachOSliceArtifactReader.js";
import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../src/artifacts/ArtifactPaths.js";
import {
  artifactExtractionInputSchema,
  artifactInventoryInputSchema,
} from "../src/contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { ok } from "../src/domain/result.js";
import type { NativeCommandRunner } from "../src/native/CommandRunner.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../src/domain/artifactGraph.js";

describe("artifact graph provider", () => {
  it("inventories app trees deterministically without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-artifacts-"));
    const app = join(root, "Fixture.app");
    await mkdir(join(app, "Contents", "Resources"), { recursive: true });
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    await mkdir(join(app, "Contents", "Frameworks", "Fixture.framework"), {
      recursive: true,
    });
    const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
    await writeFile(join(app, "Contents", "MacOS", "Fixture"), machO, {
      mode: 0o755,
    });
    await writeFile(
      join(app, "Contents", "Frameworks", "Fixture.framework", "Fixture"),
      machO,
    );
    await writeFile(join(app, "Contents", "Resources", "main.js"), "main();\n");
    await writeFile(join(app, "Contents", "Resources", "main.js.MAP"), "{}\n");
    await symlink("/etc/passwd", join(app, "Contents", "Resources", "outside"));
    const client = new ArtifactProvider().createClient(
      target(app, "directory"),
    );
    const input = artifactInventoryInputSchema.parse({
      node_limit: 500,
      occurrence_limit: 500,
      edge_limit: 500,
    });
    const first = await client.execute("inventory_artifact", input);
    const second = await client.execute("inventory_artifact", input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const left = artifactInventoryResultSchema.parse(first.value.result);
    const right = artifactInventoryResultSchema.parse(second.value.result);
    expect(left.manifest).toEqual(right.manifest);
    expect(left.nodes.items.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "executable",
        "framework",
        "javascript",
        "source-map",
      ]),
    );
    expect(
      left.occurrences.items.find(({ logical_path: path }) =>
        path.endsWith("outside"),
      ),
    ).toMatchObject({ artifact_id: null, entry_kind: "symlink" });
    const script = left.occurrences.items.find(({ logical_path: path }) =>
      path.endsWith("main.js"),
    );
    const sourceMap = left.occurrences.items.find(({ logical_path: path }) =>
      path.endsWith("main.js.MAP"),
    );
    expect(left.edges.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "maps-source",
          parent_artifact_id: script?.artifact_id,
          child_artifact_id: sourceMap?.artifact_id,
        }),
      ]),
    );
  });

  it("streams ZIP and official ASAR inventories within shared limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-containers-"));
    const zipPath = join(root, "fixture.apk");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add("assets/index.js", new TextReader("export default 1;"));
    await zipWriter.add("lib/arm64-v8a/addon.so", new TextReader("native"));
    await writeFile(zipPath, await zipWriter.close());
    const parsed = await parseBinaryTarget(zipPath);
    expect(parsed.ok && parsed.value.format).toBe("apk");
    if (!parsed.ok) return;
    const zipResult = await inventory(parsed.value);
    expect(zipResult.occurrences.total).toBe(3);
    expect(zipResult.nodes.items.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["javascript", "dynamic-library"]),
    );
    const cliEvidence = parseEvidence(
      await runProviderAnalysis(zipPath, "inventory_artifact", {}),
    );
    expect(cliEvidence).toMatchObject({
      operation: "inventory_artifact",
      provider: { id: "rea-artifact-graph" },
      subject: { format: "apk" },
    });
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      runProviderAnalysis(
        zipPath,
        "inventory_artifact",
        {},
        undefined,
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ code: "cancelled" });

    const source = join(root, "asar-source");
    await mkdir(source);
    await writeFile(join(source, "main.js"), "console.log('ok');\n");
    const asarPath = join(root, "app.asar");
    await createPackage(source, asarPath);
    const asarResult = await inventory(target(asarPath, "asar"));
    expect(asarResult.occurrences.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_path: "main.js" }),
      ]),
    );

    const unpackedPath = join(root, "unpacked.asar");
    await createPackageWithOptions(source, unpackedPath, { unpack: "*.js" });
    const unpackedResult = await inventory(target(unpackedPath, "asar"));
    expect(unpackedResult.occurrences.items).toEqual(
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
    const corrupted = await new ArtifactProvider()
      .createClient(target(unpackedPath, "asar"))
      .execute("inventory_artifact", artifactInventoryInputSchema.parse({}));
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
  });

  it("classifies mobile and managed runtime artifacts without executing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-mobile-artifacts-"));
    const apkPath = join(root, "fixture.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "AndroidManifest.xml",
      new TextReader("binary manifest placeholder"),
    );
    await writer.add("resources.arsc", new TextReader("resources"));
    await writer.add(
      "classes.dex",
      new TextReader("dex\n035\0fixture bytecode"),
    );
    await writer.add(
      "assets/Fixture.class",
      new TextReader("\xca\xfe\xba\xbeclass bytes"),
    );
    await writer.add("assets/module.wasm", new TextReader("\0asm\u0001\0\0\0"));
    await writeFile(apkPath, await writer.close());

    const result = await inventory(target(apkPath, "apk"));
    const formats = result.nodes.items.map(({ format }) => format);
    expect(formats).toEqual(
      expect.arrayContaining([
        "android-manifest",
        "android-resources",
        "dex",
        "jvm-class",
        "webassembly",
      ]),
    );
    expect(result.nodes.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "package-metadata" }),
        expect.objectContaining({ kind: "bytecode", format: "dex" }),
        expect.objectContaining({ kind: "bytecode", format: "jvm-class" }),
      ]),
    );
  });

  it("rejects unsafe, colliding, and over-ratio entries", async () => {
    expect(() => normalizeArtifactPath("../escape", limits())).toThrow(
      /normalized/u,
    );
    const registry = new ArtifactPathRegistry();
    registry.add("A.js", "file");
    expect(() => registry.add("a.js", "file")).toThrow(/collision/u);

    const root = await mkdtemp(join(tmpdir(), "rea-bomb-"));
    const zipPath = join(root, "bomb.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("zeros", new TextReader("0".repeat(100_000)));
    await writeFile(zipPath, await writer.close());
    const client = new ArtifactProvider().createClient(target(zipPath, "zip"));
    const result = await client.execute(
      "inventory_artifact",
      artifactInventoryInputSchema.parse({ max_compression_ratio: 2 }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "limit" },
    });
  });

  it("extracts only selected occurrences through an exclusively owned output tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-extract-"));
    const source = join(root, "source");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets", "selected.js"), "selected();\n");
    await writeFile(join(source, "assets", "ignored.js"), "ignored();\n");
    const targetValue = target(source, "directory");
    const graph = await inventory(targetValue);
    const selected = graph.occurrences.items.find(
      ({ logical_path: path }) => path === "assets/selected.js",
    );
    expect(selected).toBeDefined();
    if (selected === undefined) return;
    const cancelledOutput = join(root, "cancelled-output");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: cancelledOutput,
          occurrence_ids: [selected.occurrence_id],
        }),
        { signal: controller.signal },
      );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(cancelledOutput)).rejects.toThrow();
    const output = join(root, "output");
    const result = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: output,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstExtraction = artifactExtractionResultSchema.parse(
      result.value.result,
    );
    expect(firstExtraction).toMatchObject({
      output_root: "$OUTPUT_ROOT",
      containment_verified: true,
      artifacts: { total: 1 },
      extraction_manifest: { output_root_alias: "$OUTPUT_ROOT" },
    });
    expect(await readFile(join(output, "assets", "selected.js"), "utf8")).toBe(
      "selected();\n",
    );
    await expect(
      access(join(output, "assets", "ignored.js")),
    ).rejects.toThrow();

    const relocatedOutput = join(root, "relocated-output");
    const relocated = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: relocatedOutput,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(relocated.ok).toBe(true);
    if (!relocated.ok) return;
    expect(
      artifactExtractionResultSchema.parse(relocated.value.result)
        .extraction_manifest,
    ).toEqual(firstExtraction.extraction_manifest);

    const second = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: output,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(second).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.output\.rea-/u)]),
    );
  });

  it("requires both caller approval and operator policy before DMG extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-dmg-extract-policy-"));
    const path = join(root, "fixture.dmg");
    await writeFile(path, "not mounted");
    const targetValue = target(path, "dmg");
    const occurrenceId = `occ_${"0".repeat(64)}`;
    const outputRoot = join(root, "output");

    const withoutApproval = await new ArtifactProvider(true)
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: outputRoot,
          occurrence_ids: [occurrenceId],
        }),
      );
    expect(withoutApproval).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "unavailable" },
    });

    const disabledByPolicy = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          native_mount_approved: true,
          output_root: outputRoot,
          occurrence_ids: [occurrenceId],
        }),
      );
    expect(disabledByPolicy).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "unavailable" },
    });
    await expect(access(outputRoot)).rejects.toThrow();
  });

  it("paginates wide graphs without changing manifest identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-wide-"));
    await Promise.all(
      Array.from({ length: 520 }, async (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(4, "0")}.txt`),
          `${index}`,
        ),
      ),
    );
    const client = new ArtifactProvider().createClient(
      target(root, "directory"),
    );
    const [first, secondPage] = await Promise.all([
      client.execute(
        "inventory_artifact",
        artifactInventoryInputSchema.parse({ occurrence_limit: 500 }),
      ),
      client.execute(
        "inventory_artifact",
        artifactInventoryInputSchema.parse({
          occurrence_offset: 500,
          occurrence_limit: 500,
        }),
      ),
    ]);
    expect(first.ok && secondPage.ok).toBe(true);
    if (!first.ok || !secondPage.ok) return;
    const left = artifactInventoryResultSchema.parse(first.value.result);
    const right = artifactInventoryResultSchema.parse(secondPage.value.result);
    expect(left.manifest).toEqual(right.manifest);
    expect(left.occurrences).toMatchObject({ total: 521, next_offset: 500 });
    expect(right.occurrences).toMatchObject({
      offset: 500,
      next_offset: null,
    });
  }, 15_000);

  it("uses bounded native lipo metadata for universal slice ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-slices-"));
    const binary = join(root, "fat");
    await writeFile(binary, Buffer.from("0123456789abcdef"));
    const runner: NativeCommandRunner = {
      run: () =>
        Promise.resolve(
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout:
              "architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 0\n size 8\n align 2^2\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8\n size 8\n align 2^2\n",
            stderr: "",
            stdoutBytes: 1,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: 0,
            signal: null,
          }),
        ),
    };
    const reader = new MachOSliceArtifactReader(binary, runner);
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries).toHaveLength(2);
    const secondEntry = entries[1];
    expect(secondEntry).toBeDefined();
    if (secondEntry === undefined) return;
    expect(secondEntry).toMatchObject({
      path: "slices/arm64",
      byteOffset: 8,
      declaredSize: 8,
    });
    const chunks: Buffer[] = [];
    const stream = await reader.open(secondEntry);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("89abcdef");
    expect(reader.provenance()).toEqual([
      expect.objectContaining({ tool: "lipo", effects: ["read"] }),
    ]);
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("lipo");
  });
});

const inventory = async (targetValue: BinaryTarget) => {
  const result = await new ArtifactProvider().createClient(targetValue).execute(
    "inventory_artifact",
    artifactInventoryInputSchema.parse({
      node_limit: 500,
      occurrence_limit: 500,
      edge_limit: 500,
    }),
  );
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};

const target = (
  path: string,
  format: BinaryTarget["format"] | "directory",
): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: format === "directory" ? "executable" : "archive",
  format: format === "directory" ? "mach-o" : format,
});

const limits = () => ({ maxDepth: 20, maxPathBytes: 4_096 });
