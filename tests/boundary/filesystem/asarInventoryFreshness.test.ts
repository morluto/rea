import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { buffer } from "node:stream/consumers";

import { createPackage, listPackage, uncache } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/application/ArtifactInventory.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const CONTENT = "module.exports = 42;\n";

const archiveFixture = async () => {
  const root = await createTestTempDirectory("rea-asar-freshness-");
  const source = join(root, "source");
  const bundle = join(root, "app");
  await Promise.all([mkdir(source), mkdir(bundle)]);
  const archive = join(bundle, "app.asar");
  await writeFile(join(source, "old.js"), CONTENT);
  await createPackage(source, archive);
  return {
    archive,
    bundle,
    source,
    replace: async () => {
      await rm(join(source, "old.js"));
      await writeFile(join(source, "new.js"), CONTENT);
      await createPackage(source, archive);
    },
  };
};

describe("ASAR path boundary", () => {
  it("keeps inventory paths portable and opens nested entries from a packed archive", async () => {
    const root = await createTestTempDirectory("rea-asar-paths-");
    const source = join(root, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "main.js"), CONTENT);
    const archive = join(root, "paths.asar");
    await createPackage(source, archive);
    const reader = new AsarArtifactReader(archive);

    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries.map(({ path, kind }) => [path, kind])).toEqual([
        ["nested", "directory"],
        ["nested/main.js", "file"],
      ]);
      const nestedFile = entries.find(({ path }) => path === "nested/main.js");
      if (!nestedFile) throw new Error("Expected packed nested ASAR file");
      expect((await buffer(await reader.open(nestedFile))).toString()).toBe(
        CONTENT,
      );
    } finally {
      await reader.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "reports packed ASAR symlinks without following them",
    async () => {
      const root = await createTestTempDirectory("rea-asar-symlink-");
      const source = join(root, "source");
      await mkdir(join(source, "nested"), { recursive: true });
      await writeFile(join(source, "nested", "main.js"), CONTENT);
      await symlink("nested/main.js", join(source, "alias.js"));
      const archive = join(root, "symlink.asar");
      await createPackage(source, archive);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        expect(entries.find(({ path }) => path === "alias.js")).toMatchObject({
          kind: "symlink",
          path: "alias.js",
        });
      } finally {
        await reader.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves literal backslashes in POSIX ASAR filenames",
    async () => {
      const root = await createTestTempDirectory("rea-asar-backslash-");
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "literal\\name.js"), CONTENT);
      const archive = join(root, "backslash.asar");
      await createPackage(source, archive);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const file = entries.find(({ path }) => path === "literal\\name.js");
        if (!file) throw new Error("Expected literal-backslash ASAR entry");
        expect((await buffer(await reader.open(file))).toString()).toBe(
          CONTENT,
        );
      } finally {
        await reader.close();
      }
    },
  );
});

describe("ASAR inventory freshness", () => {
  it("preserves missing-container I/O as an I/O failure instead of malformed format", async () => {
    const root = await createTestTempDirectory("rea-asar-missing-");
    const reader = new AsarArtifactReader(join(root, "missing.asar"));

    await expect(reader.entries().next()).rejects.toMatchObject({
      reason: "io",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it.each(["archive", "bundle"] as const)(
    "refreshes a replaced archive when inventorying a %s target",
    async (target) => {
      const fixture = await archiveFixture();
      try {
        const first = await inventoryArtifact(fixture[target]);
        const prefix = target === "bundle" ? "app.asar/" : "";
        expect(
          first.occurrences.map(({ logical_path }) => logical_path),
        ).toContain(`${prefix}old.js`);
        expect(await inventoryArtifact(fixture[target])).toEqual(first);

        await fixture.replace();
        const second = await inventoryArtifact(fixture[target]);
        expect(second.manifest.root_sha256).not.toBe(
          first.manifest.root_sha256,
        );
        expect(second.integrity_contradictions).toEqual([]);
        const paths = second.occurrences.map(
          ({ logical_path }) => logical_path,
        );
        expect(paths).toContain(`${prefix}new.js`);
        expect(paths).not.toContain(`${prefix}old.js`);
        expect(await inventoryArtifact(fixture[target])).toEqual(second);
      } finally {
        uncache(fixture.archive);
      }
    },
  );

  it("refreshes a header cached before the reader was created", async () => {
    const fixture = await archiveFixture();
    try {
      expect(listPackage(fixture.archive, { isPack: false })).toEqual([
        `${sep}old.js`,
      ]);
      await fixture.replace();
      const inventory = await inventoryArtifact(fixture.archive);
      expect(
        inventory.occurrences.map(({ logical_path }) => logical_path),
      ).toEqual([".", "new.js"]);
    } finally {
      uncache(fixture.archive);
    }
  });

  it("keeps another reader usable after a shared archive reader closes twice", async () => {
    const fixture = await archiveFixture();
    await writeFile(join(fixture.source, "second.js"), "second member\n");
    await createPackage(fixture.source, fixture.archive);
    const first = new AsarArtifactReader(fixture.archive);
    const second = new AsarArtifactReader(fixture.archive);
    const firstEntries = first.entries()[Symbol.asyncIterator]();
    const secondEntries = second.entries()[Symbol.asyncIterator]();
    try {
      const firstEntry = await firstEntries.next();
      const secondEntry = await secondEntries.next();
      if (firstEntry.done || secondEntry.done)
        throw new Error("Expected an ASAR file entry");
      expect(secondEntry.value.path).toBe("old.js");
      await first.close();
      await first.close();
      expect(
        (await buffer(await second.open(secondEntry.value))).toString(),
      ).toBe(CONTENT);
      const remainingEntry = await secondEntries.next();
      if (remainingEntry.done) throw new Error("Expected a second ASAR entry");
      expect(remainingEntry.value.path).toBe("second.js");
      expect(
        (await buffer(await second.open(remainingEntry.value))).toString(),
      ).toBe("second member\n");
      expect((await secondEntries.next()).done).toBe(true);
    } finally {
      await firstEntries.return?.();
      await secondEntries.return?.();
      await first.close();
      await second.close();
      uncache(fixture.archive);
    }
  });

  it("releases the selected archive header on close after a cancelled read", async () => {
    const fixture = await archiveFixture();
    const reader = new AsarArtifactReader(fixture.archive);
    const entries = reader.entries()[Symbol.asyncIterator]();
    try {
      const entry = await entries.next();
      if (entry.done) throw new Error("Expected an ASAR file entry");
      const controller = new AbortController();
      controller.abort();
      await expect(async () =>
        reader.open(entry.value, controller.signal),
      ).rejects.toMatchObject({ reason: "cancelled" });
      await entries.return?.();
      await reader.close();

      await fixture.replace();
      expect(listPackage(fixture.archive, { isPack: false })).toEqual([
        `${sep}new.js`,
      ]);
    } finally {
      await entries.return?.();
      await reader.close();
      uncache(fixture.archive);
    }
  });
});
