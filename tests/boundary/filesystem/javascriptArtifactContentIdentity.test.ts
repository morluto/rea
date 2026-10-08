import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../src/artifacts/javascript/JavaScriptArtifactFiles.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fixture = async () => {
  const root = await createTestTempDirectory("rea-ingestion-content-identity-");
  const source = join(root, "source");
  const bundle = join(root, "bundle");
  await Promise.all([mkdir(source), mkdir(bundle)]);
  await writeFile(join(source, "main.js"), "module.exports = 42;\n");
  await writeFile(join(source, "asset.txt"), "original asset");
  const archive = join(bundle, "app.asar");
  await createPackage(source, archive);
  return { source, bundle, archive };
};

describe("JavaScript artifact ingestion content identities", () => {
  it.each([
    ["changed-asset", "directory"],
    ["added-asset", "directory"],
    ["changed-asset", "asar"],
    ["added-asset", "asar"],
  ])(
    "rejects a rebuilt container with %s for a %s input and unchanged source",
    async (change, format) => {
      const { source, bundle, archive } = await fixture();
      const snapshot = await scanArtifactInventory(
        format === "asar" ? archive : bundle,
      );
      await writeFile(
        join(source, change === "changed-asset" ? "asset.txt" : "new.txt"),
        "rebuilt asset",
      );
      await createPackage(source, archive);
      const reader =
        format === "asar"
          ? new AsarArtifactReader(archive)
          : new DirectoryArtifactReader(bundle);
      try {
        await expect(
          readJavaScriptArtifactFiles(reader, snapshot),
        ).rejects.toMatchObject({ reason: "integrity" });
      } finally {
        await reader.close();
      }
    },
  );

  it("rejects changed opaque native-addon bytes after inventory", async () => {
    const root = await createTestTempDirectory("rea-ingestion-native-bytes-");
    const addon = join(root, "addon.node");
    await writeFile(addon, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1]));
    const snapshot = await scanArtifactInventory(root);
    await writeFile(addon, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 2]));
    const reader = new DirectoryArtifactReader(root);
    try {
      await expect(
        readJavaScriptArtifactFiles(reader, snapshot),
      ).rejects.toMatchObject({ reason: "integrity" });
    } finally {
      await reader.close();
    }
  });

  it("preserves an unchanged direct ASAR raw identity and source", async () => {
    const { archive } = await fixture();
    const snapshot = await scanArtifactInventory(archive);
    const reader = new AsarArtifactReader(archive);
    try {
      const files = await readJavaScriptArtifactFiles(reader, snapshot);
      expect(files.containers).toEqual([]);
      expect(files.files.find(({ path }) => path === "main.js")).toMatchObject({
        container_sha256: snapshot.manifest.root_sha256,
        text: { included: true, value: "module.exports = 42;\n" },
      });
    } finally {
      await reader.close();
    }
  });

  it("rejects a same-size ASAR replacement against the inventoried root digest", async () => {
    const { source, archive } = await fixture();
    const snapshot = await scanArtifactInventory(archive);
    const original = await lstat(archive);
    await writeFile(join(source, "main.js"), "module.exports = 43;\n");
    await createPackage(source, archive);
    expect((await lstat(archive)).size).toBe(original.size);

    const reader = new AsarArtifactReader(archive);
    try {
      await expect(
        readJavaScriptArtifactFiles(reader, snapshot),
      ).rejects.toMatchObject({ reason: "integrity" });
    } finally {
      await reader.close();
    }
  });

  it("preserves typed cancellation when the direct ASAR filesystem stream aborts", async () => {
    const { archive } = await fixture();
    const snapshot = await scanArtifactInventory(archive);
    const reader = new AsarArtifactReader(archive);
    const controller = new AbortController();
    try {
      const reading = readJavaScriptArtifactFiles(
        reader,
        snapshot,
        controller.signal,
      );
      controller.abort();
      await expect(reading).rejects.toMatchObject({ reason: "cancelled" });
    } finally {
      await reader.close();
    }
  });

  it("retains native filesystem errors for outer IO classification", async () => {
    const { archive } = await fixture();
    const snapshot = await scanArtifactInventory(archive);
    await rm(archive);
    const reader = new AsarArtifactReader(archive);
    try {
      await expect(
        readJavaScriptArtifactFiles(reader, snapshot),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await reader.close();
    }
  });

  it("preserves unchanged container and opaque addon identities", async () => {
    const { bundle } = await fixture();
    await writeFile(join(bundle, "addon.node"), Buffer.from([1, 2, 3]));
    const snapshot = await scanArtifactInventory(bundle);
    const reader = new DirectoryArtifactReader(bundle);
    try {
      const files = await readJavaScriptArtifactFiles(reader, snapshot);
      expect(files.containers).toHaveLength(1);
      expect(
        files.files.find(({ path }) => path === "addon.node"),
      ).toMatchObject({
        text: { included: false, reason: "not-applicable" },
      });
      expect(
        files.files.find(({ path }) => path === "app.asar/main.js")?.text,
      ).toEqual({ included: true, value: "module.exports = 42;\n" });
    } finally {
      await reader.close();
    }
  });
});
