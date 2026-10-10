import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { snapshotRoots } from "./FilesystemSnapshot.js";
import { classifyFilesystemEffects } from "./ProcessFilesystemEffects.js";

it.each(["after", "before"] as const)(
  "keeps absence unknown when the %s snapshot omits an existing file",
  async (partialSide) => {
    // Enumeration order is filesystem-dependent. Choose a genuinely omitted
    // entry by comparing a complete snapshot with a capacity-limited one.
    const root = await createTestTempDirectory("rea-fs-partial-absence-");
    await writeFile(join(root, "a1.txt"), "first");
    await writeFile(join(root, "a2.txt"), "second");
    await writeFile(join(root, "z.txt"), "target");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { files: 2 },
    });
    const complete = await snapshotRoots({
      ...scenario,
      limits: { ...scenario.limits, files: 4 },
    });
    const partial = await snapshotRoots(scenario);
    expect(complete.completeRoots).toEqual(["root_0"]);
    expect(partial.truncated).toBe(true);
    const omitted = complete.files.find(
      (file) => !partial.files.some(({ path }) => path === file.path),
    );
    if (omitted === undefined) throw new Error("Expected an omitted entry");
    const before = partialSide === "before" ? partial : complete;
    const after = partialSide === "after" ? partial : complete;
    const effect = classifyFilesystemEffects(before, after).find(
      ({ path }) => path === omitted.path,
    );
    expect(effect?.status).toBe("unknown");
    expect(effect).toMatchObject({
      ...(partialSide === "after"
        ? { before: omitted, after: null }
        : { before: null, after: omitted }),
      reason: expect.stringContaining("did not exhaust path enumeration"),
    });
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

it.each([
  { name: "both", beforeOmitted: true, afterOmitted: true, contents: "after!" },
  {
    name: "before",
    beforeOmitted: true,
    afterOmitted: false,
    contents: "after!",
  },
  {
    name: "after",
    beforeOmitted: false,
    afterOmitted: true,
    contents: "after!",
  },
  {
    name: "both for an untouched file",
    beforeOmitted: true,
    afterOmitted: true,
    contents: "before",
  },
])(
  "keeps content equality unknown when $name snapshots omit its digest",
  async ({ beforeOmitted, afterOmitted, contents }) => {
    const root = await createTestTempDirectory("rea-fs-content-unknown-");
    const budgetFile = join(root, "a.txt");
    const file = join(root, "b.txt");
    await writeFile(file, "before");
    if (beforeOmitted) await writeFile(budgetFile, "budget");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { file_bytes: 6 },
    });
    const before = await snapshotRoots(scenario);
    if (beforeOmitted && !afterOmitted) await rm(budgetFile);
    if (!beforeOmitted && afterOmitted) await writeFile(budgetFile, "budget");
    if (contents !== "before") await writeFile(file, contents);
    const after = await snapshotRoots(scenario);
    expect(await readFile(file, "utf8")).toBe(contents);
    const effect = classifyFilesystemEffects(before, after).find(
      ({ path }) => path === "root_0:b.txt",
    );
    expect(effect).toMatchObject({
      status: "unknown",
      before: {
        type: "file",
        size: 6,
        sha256: beforeOmitted ? null : expect.any(String),
      },
      after: {
        type: "file",
        size: 6,
        sha256: afterOmitted ? null : expect.any(String),
      },
      reason: expect.stringMatching(/content.*hash|hash.*content/iu),
    });
  },
);

it("preserves observed content and metadata changes without treating missing hashes as equality", async () => {
  const root = await createTestTempDirectory("rea-fs-observed-changes-");
  for (const name of ["changed", "stable", "unhashed", "retyped"])
    await writeFile(join(root, name), "before");
  const scenario = parseProcessScenario({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [root],
  });
  const before = await snapshotRoots(scenario);
  await writeFile(join(root, "changed"), "after!");
  await writeFile(join(root, "unhashed"), "different size");
  await rm(join(root, "retyped"));
  await mkdir(join(root, "retyped"));
  const after = await snapshotRoots(scenario);
  const effects = classifyFilesystemEffects(before, after);
  expect(effects.find(({ path }) => path === "root_0:changed")?.status).toBe(
    "modified",
  );
  expect(effects.find(({ path }) => path === "root_0:stable")?.status).toBe(
    "unchanged",
  );
  expect(effects.find(({ path }) => path === "root_0:retyped")?.status).toBe(
    "modified",
  );
  const noHashes = parseProcessScenario({
    ...scenario,
    limits: { file_bytes: 1 },
  });
  const unhashedBefore = await snapshotRoots(noHashes);
  await writeFile(join(root, "unhashed"), "size changed again");
  const unhashedAfter = await snapshotRoots(noHashes);
  expect(
    classifyFilesystemEffects(unhashedBefore, unhashedAfter).find(
      ({ path }) => path === "root_0:unhashed",
    ),
  ).toMatchObject({
    status: "modified",
    before: { sha256: null },
    after: { sha256: null },
  });
});

it.skipIf(process.platform === "win32")(
  "preserves an observed permission change when file digests are omitted",
  async () => {
    const root = await createTestTempDirectory("rea-fs-mode-change-");
    const file = join(root, "file");
    await writeFile(file, "before", { mode: 0o600 });
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [file],
      limits: { file_bytes: 1 },
    });
    const before = await snapshotRoots(scenario);
    await chmod(file, 0o644);
    const after = await snapshotRoots(scenario);
    expect(classifyFilesystemEffects(before, after)).toMatchObject([
      { status: "modified", before: { sha256: null }, after: { sha256: null } },
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "compares directories and symlink targets without requiring file content hashes",
  async () => {
    const root = await createTestTempDirectory("rea-fs-nonfile-effects-");
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "a.txt"), "before");
    await writeFile(join(root, "b.txt"), "unused");
    await symlink("a.txt", join(root, "stable-link"));
    await symlink("a.txt", join(root, "moved-link"));
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { file_bytes: 1 },
    });
    const before = await snapshotRoots(scenario);
    await writeFile(join(root, "a.txt"), "after!");
    await rm(join(root, "moved-link"));
    await symlink("b.txt", join(root, "moved-link"));
    const after = await snapshotRoots(scenario);
    const effects = classifyFilesystemEffects(before, after);
    for (const name of ["empty", "stable-link"])
      expect(
        effects.find(({ path }) => path === `root_0:${name}`)?.status,
      ).toBe("unchanged");
    expect(
      effects.find(({ path }) => path === "root_0:moved-link")?.status,
    ).toBe("modified");
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
