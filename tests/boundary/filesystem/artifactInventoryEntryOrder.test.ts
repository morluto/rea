import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import {
  artifactOccurrenceAt,
  artifactParentPaths,
  writeOrderedZip,
} from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const permutations = [
  ["pkg/", "pkg/sub/", "pkg/sub/data.txt"],
  ["pkg/sub/data.txt", "pkg/sub/", "pkg/"],
];
const expectedParents = {
  ".": null,
  empty: ".",
  pkg: ".",
  "pkg/sub": "pkg",
  "pkg/sub/data.txt": "pkg/sub",
};

describe("artifact inventory entry order", () => {
  it.each(permutations.map((entries) => ({ entries })))(
    "parents ZIP entries correctly for $entries",
    async ({ entries }) => {
      const root = await createTestTempDirectory("rea-entry-order-");
      const archive = join(root, "ordered.zip");
      const referencePath = join(root, "reference.zip");
      await writeOrderedZip(archive, [...entries, "empty/"]);
      await writeOrderedZip(referencePath, [
        "pkg/",
        "pkg/sub/",
        "pkg/sub/data.txt",
        "empty/",
      ]);
      const observed = await inventoryArtifact(archive);
      const reference = await inventoryArtifact(referencePath);
      expect(artifactParentPaths(observed)).toEqual(expectedParents);
      expect(
        observed.occurrences.map(({ logical_path }) => logical_path),
      ).toEqual(Object.keys(expectedParents));
      for (const [path, parentPath] of Object.entries(expectedParents)) {
        if (parentPath === null) continue;
        const occurrence = artifactOccurrenceAt(observed, path);
        const parent = artifactOccurrenceAt(observed, parentPath);
        expect(observed.edges).toContainEqual(
          expect.objectContaining({
            logical_path: path,
            relation: "contains",
            parent_artifact_id: parent.artifact_id,
            child_artifact_id: occurrence.artifact_id,
          }),
        );
      }
      const empty = artifactOccurrenceAt(observed, "empty").artifact_id;
      for (const path of ["pkg", "pkg/sub"]) {
        const identity = artifactOccurrenceAt(observed, path).artifact_id;
        expect(identity).not.toBeNull();
        expect(identity).not.toBe(empty);
        expect(identity).toBe(
          artifactOccurrenceAt(reference, path).artifact_id,
        );
      }
      expect(await inventoryArtifact(archive)).toEqual(observed);
    },
  );

  it.each([
    {
      entries: ["pkg/sub/data.txt"],
      parents: { ".": null, "pkg/sub/data.txt": "." },
    },
    {
      entries: ["pkg/sub/data.txt", "pkg/"],
      parents: { ".": null, pkg: ".", "pkg/sub/data.txt": "pkg" },
    },
    {
      entries: ["pkg/sub/data.txt", "pkg/sub/"],
      parents: { ".": null, "pkg/sub": ".", "pkg/sub/data.txt": "pkg/sub" },
    },
  ])(
    "uses only observed directory parents for $entries",
    async ({ entries, parents }) => {
      const root = await createTestTempDirectory("rea-implicit-directory-");
      const archive = join(root, "implicit.zip");
      await writeOrderedZip(archive, entries);
      expect(artifactParentPaths(await inventoryArtifact(archive))).toEqual(
        parents,
      );
    },
  );
});

describe("entry-order validation and reader controls", () => {
  it.each([
    ["pkg/data.txt", "pkg/data.txt/"],
    ["pkg/data.txt/", "pkg/data.txt"],
    ["pkg/data.txt", "PKG/other.txt"],
    ["pkg/data.txt", "pkg"],
    ["../escape.txt"],
  ])("keeps invalid/colliding paths rejected for %j", async (...entries) => {
    const root = await createTestTempDirectory("rea-entry-order-invalid-");
    const archive = join(root, "invalid.zip");
    await writeOrderedZip(archive, entries);
    await expect(inventoryArtifact(archive)).rejects.toMatchObject({
      reason: "path",
    });
  });

  it("preserves ordinary directory and ASAR structure", async () => {
    const root = await createTestTempDirectory("rea-entry-order-readers-");
    const directory = join(root, "source");
    await mkdir(join(directory, "pkg", "sub"), { recursive: true });
    await mkdir(join(directory, "empty"));
    await writeFile(join(directory, "pkg", "sub", "data.txt"), "evidence\n");
    const archive = join(root, "fixture.asar");
    await createPackage(directory, archive);
    const filesystem = await inventoryArtifact(directory);
    const asar = await inventoryArtifact(archive);
    expect(artifactParentPaths(filesystem)).toEqual(expectedParents);
    expect(artifactParentPaths(asar)).toEqual(expectedParents);
    for (const path of ["empty", "pkg", "pkg/sub"])
      expect(artifactOccurrenceAt(asar, path).artifact_id).toBe(
        artifactOccurrenceAt(filesystem, path).artifact_id,
      );
  });
});
