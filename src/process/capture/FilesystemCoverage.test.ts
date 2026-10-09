import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { classifyFilesystemEffects } from "./ProcessFilesystemEffects.js";

it.each(["after", "before"] as const)(
  "keeps absence unknown when the %s snapshot omits an existing file",
  async (partialSide) => {
    const root = await createTestTempDirectory("rea-fs-partial-absence-");
    await writeFile(join(root, "z.txt"), "unchanged");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { files: 2 },
    });
    if (partialSide === "before") await writeFile(join(root, "a.txt"), "other");
    const before = await snapshotRoots(scenario);
    if (partialSide === "after") await writeFile(join(root, "a.txt"), "other");
    else await rm(join(root, "a.txt"));
    const after = await snapshotRoots(scenario);
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("unchanged");
    const effect = classifyFilesystemEffects(before, after).find(
      ({ path }) => path === "root_0:z.txt",
    );
    expect(effect?.status).toBe("unknown");
    expect(effect).toMatchObject(
      partialSide === "after"
        ? { before: { path: "root_0:z.txt" }, after: null }
        : { before: null, after: { path: "root_0:z.txt" } },
    );
  },
);

it("preserves proven deletion in an exhausted root while another root is partial", async () => {
  const root = await createTestTempDirectory("rea-fs-multiple-roots-");
  const complete = join(root, "complete");
  const partial = join(root, "partial");
  await mkdir(complete);
  await mkdir(partial);
  await writeFile(join(complete, "removed.txt"), "removed");
  await writeFile(join(partial, "first.txt"), "first");
  await writeFile(join(partial, "second.txt"), "second");
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [complete, partial],
    limits: { files: 3 },
  });
  const before = await snapshotRoots(scenario);
  await rm(join(complete, "removed.txt"));
  const after = await snapshotRoots(scenario);
  expect(before.truncated && after.truncated).toBe(true);
  expect(
    classifyFilesystemEffects(before, after).find(
      ({ path }) => path === "root_0:removed.txt",
    )?.status,
  ).toBe("deleted");
});

it("distinguishes unavailable content hashes from completed path enumeration", async () => {
  const root = await createTestTempDirectory("rea-fs-hash-coverage-");
  await writeFile(join(root, "removed.txt"), "larger than the byte budget");
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [root],
    limits: { file_bytes: 1 },
  });
  const before = await snapshotRoots(scenario);
  await rm(join(root, "removed.txt"));
  const after = await snapshotRoots(scenario);
  expect(before.truncated).toBe(true);
  expect(
    classifyFilesystemEffects(before, after).find(
      ({ path }) => path === "root_0:removed.txt",
    ),
  ).toMatchObject({ status: "deleted", before: { sha256: null }, after: null });
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains unreadable-file and sibling observations in a complete snapshot",
  async () => {
    const root = await createTestTempDirectory("rea-fs-unreadable-file-");
    const unreadable = join(root, "unreadable.txt");
    const readable = join(root, "readable.txt");
    await writeFile(unreadable, "permission denied");
    await writeFile(readable, "still observed");
    await chmod(unreadable, 0);
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
    });

    try {
      const snapshot = await snapshotRoots(scenario);
      expect(snapshot.files.map(({ path }) => path)).toEqual([
        "root_0:.",
        "root_0:readable.txt",
        "root_0:unreadable.txt",
      ]);
      expect(
        snapshot.files.find(({ path }) => path === "root_0:readable.txt")
          ?.sha256,
      ).not.toBeNull();
      expect(
        snapshot.files.find(({ path }) => path === "root_0:unreadable.txt"),
      ).toMatchObject({ type: "file", size: 17, sha256: null });
      expect(snapshot.coverage.hash_omissions).toContainEqual({
        path: "root_0:unreadable.txt",
        size_bytes: 17,
        remaining_budget_bytes:
          scenario.limits.file_bytes - Buffer.byteLength("still observed"),
        reason: "file_unavailable",
        system_code: "EACCES",
      });
      expect(snapshot.completeRoots).toEqual(["root_0"]);
    } finally {
      await chmod(unreadable, 0o600);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("preserves creation when the selected root was observed missing before capture", async () => {
  const root = await createTestTempDirectory("rea-fs-missing-root-");
  const file = join(root, "created.txt");
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [file],
  });
  const before = await snapshotRoots(scenario);
  await writeFile(file, "created");
  const after = await snapshotRoots(scenario);
  expect(before.files).toEqual([]);
  expect(before.truncated).toBe(false);
  expect(classifyFilesystemEffects(before, after)).toMatchObject([
    {
      path: "root_0:.",
      status: "created",
      before: null,
      after: { type: "file" },
    },
  ]);
});
