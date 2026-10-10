import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { classifyAndHashRoot } from "../../../src/artifacts/inventory/classify.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { artifactOccurrenceAt } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ZIP signature detection", () => {
  it.each([
    { signature: [0x50, 0x4b, 0x05, 0x06], archive: true },
    { signature: [0x50, 0x4b, 0x03, 0x06], archive: false },
    { signature: [0x50, 0x4b, 0x03, 0x04], archive: true },
    { signature: [0x50, 0x4b, 0x07, 0x08], archive: true },
  ] as const)(
    "routes representative ZIP signature $signature through inventory and target parsing",
    async ({ signature, archive }) => {
      const root = await createTestTempDirectory("rea-zip-signature-");
      const path = join(root, "input");
      await writeFile(path, Buffer.from(signature));
      expect(
        (await classifyAndHashRoot(path, false, await lstat(path))).format,
      ).toBe(archive ? "zip" : "file");
      const target = await parseBinaryTarget(path);
      if (archive)
        expect(target).toMatchObject({ ok: true, value: { format: "zip" } });
      else
        expect(target).toMatchObject({
          ok: false,
          error: { _tag: "BinaryTargetError" },
        });
    },
  );

  it("uses ZIP magic before the filename suffix", async () => {
    const root = await createTestTempDirectory("rea-zip-suffix-");
    const apk = join(root, "renamed.apk");
    const program = join(root, "program.apk");
    await writeFile(apk, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(program, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(
      (await classifyAndHashRoot(apk, false, await lstat(apk))).format,
    ).toBe("apk");
    expect(
      (await classifyAndHashRoot(program, false, await lstat(program))).format,
    ).toBe("elf");
  });

  it("requires container magic for asar, pkg, and dmg suffixes", async () => {
    const root = await createTestTempDirectory("rea-container-magic-");
    const asar = join(root, "app.asar");
    const textAsar = join(root, "notes.asar");
    const pkg = join(root, "install.pkg");
    const textPkg = join(root, "notes.pkg");
    const dmg = join(root, "image.dmg");
    const textDmg = join(root, "notes.dmg");
    const headerSize = 20;
    await writeFile(
      asar,
      Buffer.from([
        4,
        0,
        0,
        0,
        headerSize,
        0,
        0,
        0,
        headerSize - 4,
        0,
        0,
        0,
        2,
        0,
        0,
        0,
        0x7b,
        0x7d,
      ]),
    );
    await writeFile(textAsar, Buffer.from("not an asar"));
    await writeFile(pkg, Buffer.from("xar!"));
    await writeFile(textPkg, Buffer.from("not a pkg"));
    const image = Buffer.alloc(512);
    image.write("koly", 0, "ascii");
    await writeFile(dmg, image);
    await writeFile(textDmg, Buffer.from("not a dmg"));
    expect(
      (await classifyAndHashRoot(asar, false, await lstat(asar))).format,
    ).toBe("asar");
    expect(
      (await classifyAndHashRoot(textAsar, false, await lstat(textAsar)))
        .format,
    ).toBe("file");
    expect(
      (await classifyAndHashRoot(pkg, false, await lstat(pkg))).format,
    ).toBe("pkg");
    expect(
      (await classifyAndHashRoot(textPkg, false, await lstat(textPkg))).format,
    ).toBe("file");
    expect(
      (await classifyAndHashRoot(dmg, false, await lstat(dmg))).format,
    ).toBe("dmg");
    expect(
      (await classifyAndHashRoot(textDmg, false, await lstat(textDmg))).format,
    ).toBe("file");
  });

  it.each([[], [0x50], [0x50, 0x4b], [0x50, 0x4b, 0x03]])(
    "rejects an incomplete signature %j",
    async (...bytes) => {
      const root = await createTestTempDirectory("rea-zip-short-");
      const path = join(root, "input");
      await writeFile(path, Buffer.from(bytes));
      expect(
        (await classifyAndHashRoot(path, false, await lstat(path))).format,
      ).toBe("file");
      expect((await parseBinaryTarget(path)).ok).toBe(false);
    },
  );
});

describe("nested container family", () => {
  const plainZip = async (): Promise<Uint8Array> => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("readme.txt", new TextReader("hello\n"));
    return writer.close();
  };

  it("takes ZIP families from member bytes, not member suffixes", async () => {
    const root = await createTestTempDirectory("rea-nested-zip-family-");
    const path = join(root, "outer.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("inner-text.apk", new TextReader("just some text\n"));
    await writer.add("inner-real.apk", new Uint8ArrayReader(await plainZip()));
    await writer.add("renamed.bin", new Uint8ArrayReader(await plainZip()));
    await writer.add("locked.ipa", new TextReader("encrypted bytes"), {
      password: "fixture-only",
    });
    await writeFile(path, await writer.close());
    const observed = await inventoryArtifact(path);
    expect(artifactOccurrenceAt(observed, "inner-text.apk")).toMatchObject({
      artifact_kind: "resource",
      artifact_format: "file",
      limitations: [],
    });
    expect(artifactOccurrenceAt(observed, "inner-real.apk")).toMatchObject({
      artifact_kind: "container",
      artifact_format: "apk",
    });
    expect(artifactOccurrenceAt(observed, "renamed.bin")).toMatchObject({
      artifact_kind: "container",
      artifact_format: "zip",
    });
    expect(artifactOccurrenceAt(observed, "locked.ipa")).toMatchObject({
      artifact_kind: "unknown",
      artifact_format: "unknown",
      hash_status: "unavailable",
      limitations: [
        "The path suffix suggests IPA, but these bytes were not read, so the container family is unknown.",
      ],
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not name a container family for a symlink it did not follow",
    async () => {
      const root = await createTestTempDirectory("rea-nested-symlink-family-");
      const directory = join(root, "application");
      await mkdir(directory);
      await writeFile(join(directory, "real.apk"), await plainZip());
      await symlink("real.apk", join(directory, "link.apk"));
      const observed = await inventoryArtifact(directory);
      expect(artifactOccurrenceAt(observed, "link.apk")).toMatchObject({
        entry_kind: "symlink",
        artifact_kind: "unknown",
        artifact_format: "unknown",
        hash_status: "not-hashed",
        limitations: [
          "Symlink target was not followed or disclosed.",
          "The path suffix suggests APK, but these bytes were not read, so the container family is unknown.",
        ],
      });
      expect(artifactOccurrenceAt(observed, "real.apk")).toMatchObject({
        artifact_kind: "container",
        artifact_format: "apk",
      });
    },
  );
});
