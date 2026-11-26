import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createHash } from "node:crypto";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  translateArtifactFailure,
  DirectoryArtifactReader,
} from "../../../src/resources/index.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "../../../src/resources/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import { scanCanonicalArtifactInventoryInScope } from "../../../src/artifacts/inventory/scanCanonical.js";
import { scanArtifactInventory } from "../../fixtures/artifactInventory.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

describe("artifact inventory snapshot", () => {
  it("retains the complete scan after the source directory changes", async () => {
    const root = await createTestTempDirectory("rea-inventory-snapshot-");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const snapshot = await scanArtifactInventory(root);

    await rm(join(root, "b.txt"));
    expect(snapshot.occurrences.map(({ logical_path: path }) => path)).toEqual([
      ".",
      "a.txt",
      "b.txt",
    ]);
    expect(snapshot.manifest.occurrence_count).toBe(3);
  });

  it("projects complete observed inventory while owned snapshot cleanup needs retry", async () => {
    const root = await createTestTempDirectory("rea-inventory-cleanup-");
    const archive = join(root, "app.asar");
    const member = Buffer.from("observed");
    const bytes = Buffer.concat([
      asarHeaderBytes(
        JSON.stringify({
          files: { "observed.txt": { size: member.length, offset: "0" } },
        }),
      ),
      member,
    ]);
    await writeFile(archive, bytes);
    let snapshotRoot: string | undefined;
    const reader = new AsarArtifactReader(archive, {
      async removeSnapshot(path) {
        if (snapshotRoot === undefined) {
          snapshotRoot = path;
          throw new Error("injected snapshot removal failure");
        }
        await rm(path, { recursive: true, force: true });
      },
    });
    const resourceScope = new ArtifactResourceScope();
    onTestFinished(async () => {
      try {
        await resourceScope.close();
      } finally {
        await reader.close();
      }
    });
    const failure = await resourceScope
      .run(() =>
        scanCanonicalArtifactInventoryInScope(
          archive,
          { resourceScope },
          () => reader,
        ),
      )
      .then(
        () => {
          throw new Error("Expected snapshot cleanup to fail");
        },
        (cause: unknown) => cause,
      );
    if (snapshotRoot === undefined)
      throw new Error("ASAR snapshot was not observed");
    expect((await lstat(snapshotRoot)).isDirectory()).toBe(true);
    const error = translateArtifactFailure(
      "inventory_artifact",
      "/selected/artifact",
      failure,
    );
    const observation = {
      kind: "artifact-inventory",
      inventory: {
        coverage: { scope: "container-entries", status: "complete" },
        manifest: {
          root_sha256: createHash("sha256").update(bytes).digest("hex"),
          occurrence_count: 2,
        },
        occurrences: [
          { logical_path: "." },
          { logical_path: "observed.txt", hash_status: "verified" },
        ],
      },
    };
    expect(projectAnalysisError(error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        execution_failure: "artifact_operation_failed",
        resources: [snapshotRoot],
        partial_observation: observation,
      },
    });
    await resourceScope.close();
    await expect(lstat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(error.cleanupIncomplete).toBe(false);
    expect(
      projectAnalysisError(error).details?.partial_observation,
    ).toMatchObject(observation);
  });
});

it("unwinds every nested traversal and preserves its primary failure", async () => {
  const root = await createTestTempDirectory(
    "rea-inventory-traversal-cleanup-",
  );
  const contents = join(root, "contents");
  const bundle = join(root, "bundle");
  await Promise.all([mkdir(contents), mkdir(bundle)]);
  await writeFile(join(contents, "member.js"), "module.exports = 1;");
  await createPackage(contents, join(bundle, "app.asar"));
  const directory = new DirectoryArtifactReader(bundle);
  const resourceScope = new ArtifactResourceScope();
  const returned: string[] = [];
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await resourceScope.close();
  });
  const nestedEntries = AsarArtifactReader.prototype.entries;
  vi.spyOn(AsarArtifactReader.prototype, "entries").mockImplementation(
    function (
      this: AsarArtifactReader,
      signal,
    ): AsyncIterableIterator<ArtifactEntry> {
      const iterator = nestedEntries.call(this, signal)[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          await iterator.next();
          throw new ArtifactReaderFailure(
            "integrity",
            "primary nested member failure",
            { integrityCheck: "container-identity" },
          );
        },
        async return() {
          returned.push("nested");
          await iterator.return?.();
          return { done: true as const, value: undefined };
        },
      };
    },
  );
  const reader: ArtifactReader = {
    format: "directory",
    entries(signal): AsyncIterableIterator<ArtifactEntry> {
      const iterator = directory.entries(signal)[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => iterator.next(),
        async return() {
          returned.push("root");
          await iterator.return?.();
          throw new Error("root iterator cleanup failed");
        },
      };
    },
    open: (entry, signal) => directory.open(entry, signal),
    provenance: () => [],
    close: () => directory.close(),
  };

  const failure = await resourceScope
    .run(() =>
      scanCanonicalArtifactInventoryInScope(
        bundle,
        { resourceScope },
        () => reader,
      ),
    )
    .catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    reason: "integrity",
    message: "primary nested member failure",
    cleanup: {
      reason: "root iterator cleanup failed",
      resources: ["artifact traversal for directory"],
    },
  });
  expect(returned).toEqual(["nested", "root"]);
});
