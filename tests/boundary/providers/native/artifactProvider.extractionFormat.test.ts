import { access, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { elfExportImage } from "../../../fixtures/binaryDiagnostics/nativeExports.js";
import { writeOrderedZip } from "../../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { buildGodotPck, pckU64 } from "../../../fixtures/godotPck.js";
import {
  createOwnedArtifactClient,
  withArtifactClient,
} from "../../../support/artifactClientScope.js";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  CPU,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { cArchiveExecutable } from "../../../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactExtractionResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";

describe("artifact extraction format support", () => {
  it("refuses unsupported formats before inventory or output", async () => {
    const root = await createTestTempDirectory("rea-extract-format-");
    const image = join(root, "Image.dmg");
    const udif = Buffer.alloc(512);
    udif.write("koly");
    await writeFile(image, udif);
    const alias = join(root, "Alias.dmg");
    await symlink(image, alias);
    const output = join(root, "output");
    const selected = await admittedTarget(alias);
    expect(selected.format).toBe("dmg");
    const extract = (signal?: AbortSignal) =>
      createOwnedArtifactClient(selected).execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({ output_root: output }),
        signal === undefined ? undefined : { signal },
      );
    expect(await extract()).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisUnsupportedTargetError",
        operation: "extract_artifact",
        path: alias,
        reason: "Artifact format has no extraction reader: dmg",
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await extract(controller.signal)).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(output)).rejects.toThrow();
  });

  it("refuses a thin Mach-O that inventory lists as root-only", async () => {
    const root = await createTestTempDirectory("rea-extract-thin-macho-");
    const binary = join(root, "thin");
    await writeFile(binary, machoImage({ cpu: CPU.arm64e }));
    const output = join(root, "output");
    expect(
      await createOwnedArtifactClient(await admittedTarget(binary)).execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({ output_root: output }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisUnsupportedTargetError",
        operation: "extract_artifact",
        path: binary,
        reason: "Artifact format has no extraction reader: mach-o",
      },
    });
    await expect(access(output)).rejects.toThrow();
  });

  it("keeps a thin Mach-O PyInstaller onefile extractable", async () => {
    const root = await createTestTempDirectory("rea-extract-thin-macho-pyi-");
    const binary = join(root, "hello");
    await writeFile(
      binary,
      Buffer.concat([
        machoImage({ cpu: CPU.arm64 }),
        cArchiveExecutable({
          layout: "2.1",
          pythonVersion: 314,
          pythonLibrary: "libpython3.14.dylib",
          members: [
            {
              name: "hello",
              typeCode: "s",
              payload: Buffer.from("print('hi')"),
              compress: true,
            },
          ],
        }),
      ]),
    );
    const result = await createOwnedArtifactClient(
      await admittedTarget(binary),
    ).execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: join(root, "output"),
      }),
    );
    if (!result.ok) throw result.error;
    const extracted = artifactExtractionResultSchema.parse(result.value.result);
    expect(
      extracted.artifacts.map(({ relative_path }) => relative_path),
    ).toContain("hello");
  });
});

describe("artifact extraction reader selection", () => {
  it("extracts an embedded PCK using its inventoried format rather than its executable carrier", async () => {
    const root = await createTestTempDirectory("rea-extract-embedded-pck-");
    const binary = join(root, "game");
    const output = join(root, "output");
    const pack = buildGodotPck(3, [
      { path: "res://main.gd", data: "extends Node\n" },
    ]);
    await writeFile(
      binary,
      Buffer.concat([
        elfExportImage({ symbols: [] }),
        pack,
        pckU64(pack.length),
        Buffer.from("GDPC"),
      ]),
    );
    const selected = await admittedTarget(binary);
    expect(selected).toMatchObject({
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
    });
    await withArtifactClient(await admittedTarget(binary), async (client) => {
      const result = await client.execute("extract_artifact", {
        output_root: output,
      });
      if (!result.ok) throw result.error;
      const extracted = artifactExtractionResultSchema.parse(
        result.value.result,
      );
      expect(extracted.manifest.root_format).toBe("godot-pck");
      expect(
        extracted.artifacts.map(({ relative_path }) => relative_path),
      ).toEqual(["main.gd"]);
      expect(await readFile(join(output, "main.gd"), "utf8")).toBe(
        "extends Node\n",
      );
    });
  });

  it.each(["zip", "hap", "hsp", "app-pack"] as const)(
    "extracts the ZIP-backed %s package family that inventory already supports",
    async (format) => {
      const root = await createTestTempDirectory("rea-extract-zip-family-");
      const archive = join(
        root,
        `Payload.${format === "app-pack" ? "app" : format}`,
      );
      await writeOrderedZip(archive, ["payload.txt"]);
      const result = await createOwnedArtifactClient(
        await admittedTarget(archive),
      ).execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({
          output_root: join(root, "output"),
        }),
      );
      if (!result.ok) throw result.error;
      const extracted = artifactExtractionResultSchema.parse(
        result.value.result,
      );
      expect(
        extracted.artifacts.map(({ relative_path }) => relative_path),
      ).toEqual(["payload.txt"]);
    },
  );
});

const admittedTarget = async (path: string): Promise<BinaryTarget> => {
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
