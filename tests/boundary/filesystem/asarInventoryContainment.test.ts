import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import {
  artifactOccurrenceAt,
  artifactParentPaths,
  writeOrderedZip,
} from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const mainBytes = "module.exports = 'packed member';\n";
const createNestedAsar = async () => {
  const root = await createTestTempDirectory("rea-asar-containment-");
  const source = join(root, "source");
  const application = join(root, "application");
  await mkdir(join(source, "lib"), { recursive: true });
  await mkdir(join(source, "assets.asar"));
  await mkdir(join(application, "resources"), { recursive: true });
  await writeFile(join(source, "main.js"), mainBytes);
  await writeFile(join(source, "lib", "dep.js"), "module.exports = 1;");
  await writeFile(join(source, "ordinary.asar"), "opaque archive member");
  await writeFile(join(source, "assets.asar", "data.txt"), "directory member");
  const archive = join(application, "resources", "app.asar");
  await createPackage(source, archive);
  return { root, application, archive };
};

const expectedNestedParents = {
  ".": null,
  resources: ".",
  "resources/app.asar": "resources",
  "resources/app.asar/assets.asar": "resources/app.asar",
  "resources/app.asar/assets.asar/data.txt": "resources/app.asar/assets.asar",
  "resources/app.asar/lib": "resources/app.asar",
  "resources/app.asar/lib/dep.js": "resources/app.asar/lib",
  "resources/app.asar/main.js": "resources/app.asar",
  "resources/app.asar/ordinary.asar": "resources/app.asar",
};

describe("expanded ASAR inventory containment", () => {
  it("parents expanded members to their archive without changing byte identities", async () => {
    const { application, archive } = await createNestedAsar();
    const nested = await inventoryArtifact(application);
    const direct = await inventoryArtifact(archive);
    expect(artifactParentPaths(nested)).toEqual(expectedNestedParents);
    const container = artifactOccurrenceAt(nested, "resources/app.asar");
    expect(container).toMatchObject({
      entry_kind: "file",
      artifact_kind: "container",
      artifact_format: "asar",
    });
    expect(container.artifact_id).toBe(direct.manifest.root_artifact_id);
    expect(
      nested.nodes.find((node) => node.artifact_id === container.artifact_id),
    ).toMatchObject({
      format: "file",
      content_state: "embedded",
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    });
    for (const [path, parent] of Object.entries(expectedNestedParents)) {
      if (parent === null) continue;
      const child = artifactOccurrenceAt(nested, path);
      expect(nested.edges).toContainEqual(
        expect.objectContaining({
          logical_path: path,
          relation: "contains",
          parent_artifact_id: artifactOccurrenceAt(nested, parent).artifact_id,
          child_artifact_id: child.artifact_id,
        }),
      );
      if (path.startsWith("resources/app.asar/"))
        expect(child.artifact_id).toBe(
          artifactOccurrenceAt(direct, path.slice("resources/app.asar/".length))
            .artifact_id,
        );
    }
    expect(artifactParentPaths(direct)).toEqual({
      ".": null,
      "assets.asar": ".",
      "assets.asar/data.txt": "assets.asar",
      lib: ".",
      "lib/dep.js": "lib",
      "main.js": ".",
      "ordinary.asar": ".",
    });
    expect(await inventoryArtifact(application)).toEqual(nested);
  });

  it("records the actual expanded archive as the integrity contradiction parent", async () => {
    const { application, archive } = await createNestedAsar();
    const bytes = await readFile(archive);
    const offset = bytes.indexOf(Buffer.from(mainBytes));
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes[offset] = "X".charCodeAt(0);
    await writeFile(archive, bytes);
    await expect(inventoryArtifact(application)).rejects.toMatchObject({
      reason: "integrity",
    });
    const observed = await inventoryArtifact(application, {
      integrity: { mode: "record-and-continue" },
    });
    const container = artifactOccurrenceAt(observed, "resources/app.asar");
    const child = artifactOccurrenceAt(observed, "resources/app.asar/main.js");
    expect(child.hash_status).toBe("mismatched");
    expect(child.parent_occurrence_id).toBe(container.occurrence_id);
    expect(observed.integrity_contradictions).toEqual([
      expect.objectContaining({
        logical_path: "resources/app.asar/main.js",
        parent_artifact_id: container.artifact_id,
        occurrence_id: child.occurrence_id,
        trust: "observed-untrusted",
      }),
    ]);
  });
});

describe("unexpanded ASAR inventory controls", () => {
  it("does not expand ZIP members from ASAR bytes or filenames", async () => {
    const { root, archive } = await createNestedAsar();
    const path = join(root, "opaque.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("resources/", undefined, { directory: true });
    await writer.add(
      "resources/app.asar",
      new Uint8ArrayReader(await readFile(archive)),
    );
    await writer.add(
      "resources/ordinary.asar",
      new TextReader("ordinary bytes"),
    );
    await writer.add(
      "resources/encrypted.asar",
      new TextReader("encrypted bytes"),
      { password: "fixture-only" },
    );
    await writeFile(path, await writer.close());
    const observed = await inventoryArtifact(path);
    expect(artifactParentPaths(observed)).toEqual({
      ".": null,
      resources: ".",
      "resources/app.asar": "resources",
      "resources/encrypted.asar": "resources",
      "resources/ordinary.asar": "resources",
    });
    expect(
      artifactOccurrenceAt(observed, "resources/encrypted.asar").hash_status,
    ).toBe("unavailable");
  });

  it("keeps ASAR-named directories as directory parents", async () => {
    const root = await createTestTempDirectory("rea-asar-directory-");
    const path = join(root, "directory.zip");
    await writeOrderedZip(path, ["assets.asar/main.js", "assets.asar/"]);
    const observed = await inventoryArtifact(path);
    expect(artifactParentPaths(observed)).toEqual({
      ".": null,
      "assets.asar": ".",
      "assets.asar/main.js": "assets.asar",
    });
    expect(artifactOccurrenceAt(observed, "assets.asar").entry_kind).toBe(
      "directory",
    );
    const directory = join(root, "filesystem");
    await mkdir(join(directory, "assets.asar"), { recursive: true });
    await writeFile(join(directory, "assets.asar", "main.js"), "evidence\n");
    expect(artifactParentPaths(await inventoryArtifact(directory))).toEqual(
      artifactParentPaths(observed),
    );
  });

  it.each([
    ["ordinary.asar", "ordinary.asar/main.js"],
    ["ordinary.asar/main.js", "ordinary.asar"],
  ])(
    "rejects opaque file-prefix conflicts in either order: %j",
    async (...entries) => {
      const root = await createTestTempDirectory("rea-asar-prefix-");
      const path = join(root, "conflict.zip");
      await writeOrderedZip(path, entries);
      await expect(inventoryArtifact(path)).rejects.toMatchObject({
        reason: "path",
      });
    },
  );

  it("keeps malformed filesystem archives rejected", async () => {
    const root = await createTestTempDirectory("rea-malformed-asar-");
    await writeFile(join(root, "ordinary.asar"), "ordinary bytes");
    await expect(inventoryArtifact(root)).rejects.toMatchObject({
      reason: "format",
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not follow filesystem ASAR symlinks",
    async () => {
      const { root, archive } = await createNestedAsar();
      const directory = join(root, "links");
      await mkdir(directory);
      await symlink(archive, join(directory, "app.asar"));
      const observed = await inventoryArtifact(directory);
      expect(artifactParentPaths(observed)).toEqual({
        ".": null,
        "app.asar": ".",
      });
      expect(artifactOccurrenceAt(observed, "app.asar").entry_kind).toBe(
        "symlink",
      );
    },
  );
});
