import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { readReferenceSource } from "../../support/referenceSourceResourceScope.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

/** More children than one call can receive as arguments on V8's default stack. */
const CHILD_DIRECTORIES = 130_000;
const childNames = (): string[] =>
  Array.from({ length: CHILD_DIRECTORIES }, (_, index) => `d${index}`);

const missingChildren = (paths: Iterable<string>): string[] => {
  const listed = new Set(paths);
  return childNames().filter((name) => !listed.has(name));
};

const traverse = async (
  root: string,
  maximumEntries: number,
  stopAfter?: { readonly entries: number; readonly reason: Error },
): Promise<{ readonly paths: string[]; readonly failure: unknown }> => {
  const reader = new DirectoryArtifactReader(root);
  const controller = new AbortController();
  const paths: string[] = [];
  try {
    for await (const entry of reader.entries(controller.signal, {
      maximumEntries,
    })) {
      paths.push(entry.path);
      if (paths.length === stopAfter?.entries)
        controller.abort(stopAfter.reason);
    }
    return { paths, failure: undefined };
  } catch (failure: unknown) {
    return { paths, failure };
  } finally {
    await reader.close();
  }
};

// One shallow tree serves both independent traversal owners; every child is
// empty, so only the parent's child list is wide.
describe("directory traversal of a parent wider than call arguments allow", () => {
  let workspace: TestWorkspace | undefined;
  let root = "";
  beforeAll(async () => {
    workspace = await createTestWorkspace("rea-wide-directory-");
    root = await workspace.mkdir("tree");
    for (const name of childNames()) mkdirSync(join(root, name));
  }, 60_000);
  afterAll(async () => {
    if (workspace !== undefined) await removeTestWorkspace(workspace.root);
  }, 60_000);

  it("schedules the artifact reader's children within the selected entry budget", async () => {
    // Cancel once the parent listing is complete. The next cancellation
    // checkpoint follows scheduling its children for descent.
    const reason = new Error("Stop after the wide parent listing");
    const listed = await traverse(root, CHILD_DIRECTORIES, {
      entries: CHILD_DIRECTORIES,
      reason,
    });
    expect(listed.failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(listed.failure).toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect(listed.paths).toHaveLength(CHILD_DIRECTORIES);
    expect(missingChildren(listed.paths)).toEqual([]);

    // A smaller selected allowance stays a typed refusal at its actual bound.
    const refused = await traverse(root, 2_000);
    expect(refused.paths).toHaveLength(2_000);
    expect(refused.failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(refused.failure).toMatchObject({
      reason: "limit",
      examinedEntries: 2_000,
      maximumEntries: 2_000,
    });
  }, 60_000);

  it("reads every child directory into the reference-source inventory", async () => {
    const result = await readReferenceSource(root);
    if (!result.ok) throw result.error;
    const { entries } = result.value;
    expect(entries).toHaveLength(CHILD_DIRECTORIES);
    expect(
      entries.filter(
        (entry) => entry.status !== "read" || entry.kind !== "directory",
      ),
    ).toEqual([]);
    expect(missingChildren(entries.map(({ path }) => path))).toEqual([]);
  }, 120_000);
});
