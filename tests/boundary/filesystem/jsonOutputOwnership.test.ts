import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { EvidenceFileError } from "../../../src/domain/evidenceErrors.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { writeTextParts } from "../../../src/application/JsonFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports committed output when post-publication staging cleanup remains owned", async () => {
  const root = await createTestTempDirectory("rea-json-write-");
  const resources = new ArtifactResourceScope();
  try {
    const result = await writeTextParts(
      stagingPollutingParts(root),
      join(root, "bundle.json"),
      false,
      resources,
    );
    if (result.ok) throw new Error("Expected staged cleanup failure");
    const cleanupResource = result.error.cleanup?.resources[0];
    if (cleanupResource === undefined)
      throw new Error("Expected retained staging resource");
    expect(result.error).toBeInstanceOf(EvidenceFileError);
    expect(result.error.published).toMatchObject({
      path: join(root, "bundle.json"),
      bytes: 16,
    });
    expect(cleanupResource).toContain(".rea-write-");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { published: true, published_path: join(root, "bundle.json") },
    });
    expect(await fs.readFile(join(root, "bundle.json"), "utf8")).toBe(
      "canonical output",
    );
    await fs.rm(join(cleanupResource, "unexpected"));
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves cancellation when staging cleanup also fails", async () => {
  const root = await createTestTempDirectory("rea-json-cancel-");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  try {
    function* cancelledParts(): Generator<string> {
      const directories = requireStages(root);
      if (directories.length !== 1)
        throw new Error("Expected one staging directory");
      writeFileSync(join(root, directories[0]!, "unexpected"), "retain this");
      controller.abort();
      yield "must not publish";
    }
    const result = await writeTextParts(
      cancelledParts(),
      join(root, "cancelled.json"),
      false,
      resources,
      { signal: controller.signal, operation: "export_evidence_bundle" },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cause).toMatchObject({
      cause: expect.any(AnalysisCancelledError),
      owner: { directory: expect.stringContaining(".rea-write-") },
    });
    await expect(fs.access(join(root, "cancelled.json"))).rejects.toThrow();
    const stage = requireStages(root)[0];
    if (stage !== undefined) await fs.rm(join(root, stage, "unexpected"));
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to publish a staged path replaced after its descriptor opened", async () => {
  const root = await createTestTempDirectory("rea-staged-swap-");
  const resources = new ArtifactResourceScope();
  const destination = join(root, "swapped.json");
  try {
    const result = await writeTextParts(
      replacingStagedParts(root),
      destination,
      false,
      resources,
    );
    if (result.ok) throw new Error("Expected staged identity rejection");
    expect(
      await fs.readFile(join(root, requireStages(root)[0]!, "content"), "utf8"),
    ).toBe("foreign bytes");
    await expect(fs.access(destination)).rejects.toThrow();
    const stage = requireStages(root)[0];
    if (stage !== undefined) {
      const directory = join(root, stage);
      await fs.rm(join(directory, "content"));
      await fs.rename(join(directory, "original"), join(directory, "content"));
    }
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not invent a staged owner when the supplied scope is closed", async () => {
  const root = await createTestTempDirectory("rea-closed-output-scope-");
  const resources = new ArtifactResourceScope();
  await resources.close();
  const destination = join(root, "closed.json");
  const result = await writeTextParts(
    ["unused"],
    destination,
    false,
    resources,
  );
  if (result.ok) throw new Error("Expected closed-scope admission failure");
  expect(result.error).toBeInstanceOf(EvidenceFileError);
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
});

function stagingPollutingParts(root: string): Iterable<string> {
  return {
    *[Symbol.iterator](): Generator<string> {
      const directories = readdirSync(root);
      const stage = directories.find((entry) =>
        entry.startsWith(".rea-write-"),
      );
      if (stage === undefined) throw new Error("Expected staging directory");
      writeFileSync(join(root, stage, "unexpected"), "retain this");
      yield "canonical output";
    },
  };
}

function replacingStagedParts(root: string): Iterable<string> {
  return {
    *[Symbol.iterator](): Generator<string> {
      const stage = requireStages(root)[0];
      if (stage === undefined) throw new Error("Expected staging directory");
      const content = join(root, stage, "content");
      renameSync(content, join(root, stage, "original"));
      writeFileSync(content, "foreign bytes");
      yield "owned bytes";
    },
  };
}

const requireStages = (root: string): string[] =>
  readdirSync(root).filter((entry) => entry.startsWith(".rea-write-"));

it("retains a failed file close owner and retries before removing its stage", async () => {
  const root = await createTestTempDirectory("rea-staged-close-");
  const directory = join(root, ".rea-write-owned");
  await mkdir(directory);
  const path = join(directory, "content");
  const handle = await open(path, "wx", 0o600);
  const owner = await OwnedStagedOutput.create(directory);
  let closeAttempts = 0;
  const actualClose = handle.close.bind(handle);
  vi.spyOn(handle, "close").mockImplementation(async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("injected close failure");
    await actualClose();
  });
  await owner.setFile(new OwnedFileHandle(handle));
  const resources = new ArtifactResourceScope();
  const stagedOwner = {
    kind: "staged-output" as const,
    resource: directory,
    output: owner,
  };
  try {
    expect(await resources.release(stagedOwner)).toMatchObject({
      kind: "failed",
    });
    await resources.close();
    expect(closeAttempts).toBe(2);
    await expect(fs.access(directory)).rejects.toThrow();
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to remove unexpected files from an owned staging directory", async () => {
  const root = await createTestTempDirectory("rea-staged-replaced-");
  const directory = join(root, ".rea-write-owned");
  await mkdir(directory);
  const owner = await OwnedStagedOutput.create(directory);
  const unexpected = join(directory, "unexpected");
  writeFileSync(unexpected, "unowned");
  try {
    await expect(owner.close()).rejects.toThrow(/Unexpected staging entries/u);
    expect(await fs.readFile(unexpected, "utf8")).toBe("unowned");
  } finally {
    await fs.rm(unexpected, { force: true });
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains cleanup when its staging directory was renamed", async () => {
  const root = await createTestTempDirectory("rea-staged-renamed-dir-");
  const directory = join(root, ".rea-write-owned");
  const moved = join(root, ".rea-write-moved");
  await mkdir(directory);
  const path = join(directory, "content");
  const handle = await open(path, "wx", 0o600);
  const owner = await OwnedStagedOutput.create(directory);
  await owner.setFile(new OwnedFileHandle(handle));
  const resources = new ArtifactResourceScope();
  const stagedOwner = {
    kind: "staged-output" as const,
    resource: directory,
    output: owner,
  };
  try {
    writeFileSync(join(directory, "unexpected"), "retain this");
    expect(await resources.release(stagedOwner)).toMatchObject({
      kind: "failed",
    });
    await fs.rename(directory, moved);
    await expect(resources.close()).rejects.toThrow();
    await fs.rename(moved, directory);
    await rm(join(directory, "unexpected"));
    await expect(resources.close()).resolves.toBeUndefined();
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains cleanup when owned staged content was renamed", async () => {
  const root = await createTestTempDirectory("rea-staged-renamed-file-");
  const directory = join(root, ".rea-write-owned");
  const content = join(directory, "content");
  const moved = join(directory, "moved-content");
  await mkdir(directory);
  const handle = await open(content, "wx", 0o600);
  const owner = await OwnedStagedOutput.create(directory);
  await owner.setFile(new OwnedFileHandle(handle));
  const resources = new ArtifactResourceScope();
  const stagedOwner = {
    kind: "staged-output" as const,
    resource: directory,
    output: owner,
  };
  try {
    await fs.rename(content, moved);
    expect(await resources.release(stagedOwner)).toMatchObject({
      kind: "failed",
    });
    await expect(resources.close()).rejects.toThrow(
      /cleanup remains incomplete/u,
    );
    await fs.rename(moved, content);
    await expect(resources.close()).resolves.toBeUndefined();
  } finally {
    await resources.close();
    await rm(root, { recursive: true, force: true });
  }
});
