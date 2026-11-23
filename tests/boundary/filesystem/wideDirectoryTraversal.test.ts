import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactReaderFailure } from "../../../src/resources/ArtifactReader.js";
import { readReferenceSource } from "../../support/referenceSourceResourceScope.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import { DirectoryArtifactReader } from "../../../src/resources/index.js";

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
  onEntry?: (path: string, controller: AbortController) => void | Promise<void>,
): Promise<{ readonly paths: string[]; readonly failure: unknown }> => {
  const reader = new DirectoryArtifactReader(root);
  const controller = new AbortController();
  const paths: string[] = [];
  try {
    for await (const entry of reader.entries(controller.signal, {
      maximumEntries,
    })) {
      paths.push(entry.path);
      const observation = onEntry?.(entry.path, controller);
      if (observation !== undefined) await observation;
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
    const names = childNames();
    const batchSize = 64;
    for (let offset = 0; offset < names.length; offset += batchSize) {
      await Promise.all(
        names
          .slice(offset, offset + batchSize)
          .map((name) => mkdir(join(root, name))),
      );
    }
  });
  afterAll(async () => {
    if (workspace !== undefined) await removeTestWorkspace(workspace.root);
  });

  it("schedules the artifact reader's children within the selected entry budget", async () => {
    const reason = new Error("Stop after visiting a scheduled child");
    let marker: string | undefined;
    const listed = await traverse(
      root,
      CHILD_DIRECTORIES + 1,
      (path, controller) => {
        if (marker === undefined) {
          // Populate the first observed child so native directory order does not
          // require walking every scheduled directory to witness descent.
          marker = `${path}/probe.txt`;
          return writeFile(join(root, marker), "scheduled child");
        }
        if (path === marker) controller.abort(reason);
        return undefined;
      },
    ).finally(async () => {
      if (marker !== undefined) await rm(join(root, marker), { force: true });
    });
    expect(listed.failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(listed.failure).toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect(listed.paths).toHaveLength(CHILD_DIRECTORIES + 1);
    expect(listed.paths.at(-1)).toBe(marker);
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
  });

  it.skipIf(process.platform === "win32")(
    "reads every child directory into the reference-source inventory",
    async () => {
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
    },
  );
});
