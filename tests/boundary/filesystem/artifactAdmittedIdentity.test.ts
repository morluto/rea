import { build } from "plist";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import {
  machoImage,
  CPU,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { buildGodotPck, pckU64 } from "../../fixtures/godotPck.js";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  unlink,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../src/domain/artifactGraph.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  { format: "zip", replacement: "valid" },
  { format: "apk", replacement: "valid" },
  { format: "asar", replacement: "valid" },
  { format: "zip", replacement: "malformed" },
  { format: "asar", replacement: "malformed" },
])(
  "binds $format $replacement archive operations to the admitted source before output creation",
  async ({ format, replacement }) => {
    const root = await createTestTempDirectory(
      "rea-archive-admitted-identity-",
    );
    const path = join(root, `selected.${format}`);
    const source = join(root, "source");
    await mkdir(source);
    const writeArchive = async (value: string) => {
      if (format === "asar") {
        await writeFile(join(source, "payload.txt"), value);
        await createPackage(source, path);
      } else {
        const zip = new ZipWriter(new Uint8ArrayWriter());
        await zip.add("payload.txt", new TextReader(value));
        await writeFile(path, await zip.close());
      }
    };
    await writeArchive("admitted version one");
    const session = createTestBinarySession(new ArtifactProvider({}));
    try {
      const opened = await session.open(path);
      if (!opened.ok) throw opened.error;
      const initial = await session.execute("inventory_artifact", {});
      if (!initial.ok) throw initial.error;
      if (replacement === "malformed") await writeFile(path, "not an archive");
      else await writeArchive("changed version two");
      for (const operation of [
        "inventory_artifact",
        "inspect_artifact",
        "extract_artifact",
      ] as const) {
        const output = join(root, `refused-${operation}`);
        const result = await session.execute(
          operation,
          operation === "extract_artifact"
            ? { output_root: output, integrity_policy: "fail" }
            : {},
        );
        expect(result).toMatchObject({
          ok: false,
          error: {
            reason: "integrity",
            detail: expect.stringContaining("changed after target admission"),
          },
        });
        await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (replacement === "valid") {
        const reopened = await session.open(path);
        if (!reopened.ok) throw reopened.error;
        const inventory = await session.execute("inventory_artifact", {});
        if (!inventory.ok) throw inventory.error;
        expect(
          artifactInventoryResultSchema.parse(inventory.value.result).manifest
            .root_sha256,
        ).not.toBe(
          artifactInventoryResultSchema.parse(initial.value.result).manifest
            .root_sha256,
        );
        const extracted = await session.execute("extract_artifact", {
          output_root: join(root, "reopened-output"),
          integrity_policy: "fail",
        });
        if (!extracted.ok) throw extracted.error;
        const result = artifactExtractionResultSchema.parse(
          extracted.value.result,
        );
        expect(
          await readFile(join(result.output_root, "payload.txt"), "utf8"),
        ).toBe("changed version two");
      }
    } finally {
      expect(await session.close()).toEqual({ ok: true, value: null });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rejects retargeted ZIP selections without attributing or publishing the old packed bytes",
  async () => {
    const root = await createTestTempDirectory("rea-admitted-zip-alias-");
    const stored = join(root, "stored.zip");
    const other = join(root, "other.zip");
    const selected = join(root, "selected.zip");
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add("payload.txt", new TextReader("same bytes"));
    const bytes = await zip.close();
    await writeFile(stored, bytes);
    await writeFile(other, bytes);
    await symlink(stored, selected);
    const session = createTestBinarySession(new ArtifactProvider({}));
    try {
      const opened = await session.open(selected);
      if (!opened.ok) throw opened.error;
      await unlink(selected);
      await symlink(other, selected);
      for (const operation of [
        "inventory_artifact",
        "extract_artifact",
      ] as const) {
        const output = join(root, operation);
        const result = await session.execute(
          operation,
          operation === "extract_artifact" ? { output_root: output } : {},
        );
        expect(result).toMatchObject({
          ok: false,
          error: {
            reason: "integrity",
            detail: expect.stringContaining(
              "no longer resolves to its admitted source",
            ),
          },
        });
        await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await session.close();
    }
  },
);

it("rejects an admitted archive replaced by a directory", async () => {
  const root = await createTestTempDirectory("rea-admitted-file-directory-");
  const path = join(root, "selected.zip");
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add("payload.txt", new TextReader("original"));
  await writeFile(path, await zip.close());
  const session = createTestBinarySession(new ArtifactProvider({}));
  try {
    const opened = await session.open(path);
    if (!opened.ok) throw opened.error;
    await unlink(path);
    await mkdir(path);
    await writeFile(join(path, "payload.txt"), "replacement directory");
    const output = join(root, "output");
    expect(
      await session.execute("extract_artifact", { output_root: output }),
    ).toMatchObject({ ok: false, error: { reason: "integrity" } });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await session.close();
  }
});

it("keeps app bundle aggregate inventories live when resources change", async () => {
  const root = await createTestTempDirectory("rea-admitted-bundle-resources-");
  const app = join(root, "Fixture.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(app, "Contents", "MacOS", "fixture"),
    machoImage({ cpu: CPU.arm64e }),
  );
  await writeFile(
    join(app, "Contents", "Info.plist"),
    build({ CFBundlePackageType: "APPL", CFBundleExecutable: "fixture" }),
  );
  const payload = join(app, "Contents", "payload.txt");
  await writeFile(payload, "first resource");
  const session = createTestBinarySession(new ArtifactProvider({}));
  try {
    const opened = await session.open(app);
    if (!opened.ok) throw opened.error;
    const initial = await session.execute("inventory_artifact", {});
    if (!initial.ok) throw initial.error;
    await writeFile(payload, "second resource");
    const current = await session.execute("inventory_artifact", {});
    if (!current.ok) throw current.error;
    expect(
      artifactInventoryResultSchema.parse(current.value.result).manifest
        .root_sha256,
    ).not.toBe(
      artifactInventoryResultSchema.parse(initial.value.result).manifest
        .root_sha256,
    );
    const extracted = await session.execute("extract_artifact", {
      output_root: join(root, "output"),
    });
    if (!extracted.ok) throw extracted.error;
    const result = artifactExtractionResultSchema.parse(extracted.value.result);
    expect(
      await readFile(
        join(result.output_root, "Contents", "payload.txt"),
        "utf8",
      ),
    ).toBe("second resource");
  } finally {
    await session.close();
  }
});

it("checks embedded native packs before acceptance while preserving unsupported fast refusal", async () => {
  const root = await createTestTempDirectory("rea-admitted-native-preflight-");
  const path = join(root, "game");
  const writePack = async (text: string) => {
    const pack = buildGodotPck(2, [
      { path: "res://payload.txt", data: Buffer.from(text) },
    ]);
    await writeFile(
      path,
      Buffer.concat([
        elf(2, 1, 62),
        pack,
        pckU64(pack.length),
        Buffer.from("GDPC"),
      ]),
    );
  };
  await writePack("first");
  const session = createTestBinarySession(new ArtifactProvider({}));
  try {
    const opened = await session.open(path);
    if (!opened.ok) throw opened.error;
    await writePack("second");
    const output = join(root, "output");
    expect(
      await session.execute("extract_artifact", { output_root: output }),
    ).toMatchObject({
      ok: false,
      error: {
        reason: "integrity",
        detail: expect.stringContaining("changed after target admission"),
      },
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "not a native pack");
    expect(
      await session.execute("extract_artifact", { output_root: output }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisUnsupportedTargetError" },
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await session.close();
  }
});
