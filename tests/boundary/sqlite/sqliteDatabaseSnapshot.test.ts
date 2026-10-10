import {
  lstat,
  open,
  readFile,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import type { StableArtifactFileSystem } from "../../../src/artifacts/readStableArtifact.js";
import { captureSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseSnapshot.js";
import { inspectSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseInspection.js";
import { sqliteDatabaseFailure } from "../../../src/sqlite/SqliteDatabaseFailures.js";
import {
  createSqliteDatabaseFixture,
  SQLITE_NATIVE_LIMITS_AVAILABLE,
} from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const fixture = async (wal = false) => {
  const workspace = await createTestWorkspace("rea-sqlite-snapshot-race-");
  const database = createSqliteDatabaseFixture(workspace.root, wal);
  if (!wal) database.close();
  onTestFinished(async () => {
    if (wal) database.close();
    await removeTestWorkspace(workspace.root);
  });
  const root = await workspace.mkdir("private");
  return { workspace, database, root };
};

it.runIf(SQLITE_NATIVE_LIMITS_AVAILABLE).each(["PERSIST", "TRUNCATE"])(
  "inspects a committed %s journal without modifying the source file set",
  async (mode) => {
    const { database, root } = await fixture();
    const writer = new DatabaseSync(database.path);
    try {
      writer.exec(
        `PRAGMA journal_mode=${mode}; INSERT INTO records(id, text_value) VALUES (4, 'committed');`,
      );
    } finally {
      writer.close();
    }
    const journalPath = `${database.path}-journal`;
    const before = await readFile(journalPath);
    const beforeStat = await lstat(journalPath, { bigint: true });
    const snapshot = await captureSqliteDatabaseSnapshot(database.path, root);
    const result = inspectSqliteDatabaseSnapshot(snapshot.snapshotPath, {
      path: database.path,
      table: "records",
    });
    expect(result.rows).toMatchObject({ returned_rows: 4, truncated: false });
    expect(await readFile(journalPath)).toEqual(before);
    const afterStat = await lstat(journalPath, { bigint: true });
    expect([
      afterStat.ino,
      afterStat.size,
      afterStat.mtimeNs,
      afterStat.ctimeNs,
    ]).toEqual([
      beforeStat.ino,
      beforeStat.size,
      beforeStat.mtimeNs,
      beforeStat.ctimeNs,
    ]);
  },
);

it.runIf(process.platform !== "win32").each([
  ["database", "remove"],
  ["WAL", "remove"],
  ["database", "replace with symlink"],
  ["WAL", "replace with symlink"],
])(
  "reports an observed %s change during acquisition as changed evidence: %s",
  async (member, change) => {
    const { database, workspace, root } = await fixture(true);
    const replacement = await workspace.write("replacement", "");
    const selectedPath =
      member === "database" ? database.path : database.walPath;
    let observations = 0;
    const fileSystem: StableArtifactFileSystem = {
      lstat: async (path) => {
        if (path === selectedPath && ++observations === 2) {
          await unlink(path);
          if (change === "replace with symlink")
            await symlink(replacement, path);
        }
        return lstat(path, { bigint: true });
      },
      open,
    };
    try {
      await captureSqliteDatabaseSnapshot(
        database.path,
        root,
        undefined,
        fileSystem,
      );
      throw new Error("A disappearing source must be rejected");
    } catch (cause) {
      expect(
        sqliteDatabaseFailure(cause, database.path, "artifact-read"),
      ).toMatchObject({ _tag: "AnalysisArtifactChangedError" });
      expect(cause).toMatchObject({
        message: expect.stringContaining(selectedPath),
      });
    }
  },
);

it("refuses an active journal even before SQLite writes its magic header", async () => {
  const { database, root } = await fixture();
  const writer = new DatabaseSync(database.path);
  try {
    writer.exec(
      "PRAGMA journal_mode=PERSIST; BEGIN IMMEDIATE; INSERT INTO records(id, text_value) VALUES (4, 'uncommitted');",
    );
    const journalPath = `${database.path}-journal`;
    const journal = await readFile(journalPath);
    expect(journal.subarray(0, 8).every((byte) => byte === 0)).toBe(true);
    expect(journal.subarray(8, 28).some((byte) => byte !== 0)).toBe(true);
    const original = await readFile(database.path);
    await expect(
      captureSqliteDatabaseSnapshot(database.path, root),
    ).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("recovery"),
    });
    expect(await readFile(database.path)).toEqual(original);
    expect(await readFile(journalPath)).toEqual(journal);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("refuses an incomplete zeroed journal header", async () => {
  const { database, root } = await fixture();
  await writeFile(`${database.path}-journal`, Buffer.alloc(27));
  await expect(
    captureSqliteDatabaseSnapshot(database.path, root),
  ).rejects.toMatchObject({ reason: "format" });
});

it.runIf(process.platform !== "win32")(
  "refuses a journal symlink even when its target is empty",
  async () => {
    const { database, workspace, root } = await fixture();
    const empty = await workspace.write("empty-journal", "");
    await symlink(empty, `${database.path}-journal`);
    await expect(
      captureSqliteDatabaseSnapshot(database.path, root),
    ).rejects.toMatchObject({ reason: "path" });
  },
);

it.each(["activate", "replace", "remove"])(
  "rejects a cold journal changed during database acquisition: %s",
  async (change) => {
    const { database, root } = await fixture();
    const journalPath = `${database.path}-journal`;
    await writeFile(journalPath, Buffer.alloc(28));
    const fileSystem: StableArtifactFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      open: async (path, flags) => {
        if (path === database.path) {
          if (change === "activate")
            await writeFile(journalPath, Buffer.alloc(28, 1));
          else if (change === "remove") await unlink(journalPath);
          else {
            await rename(journalPath, `${journalPath}.previous`);
            await writeFile(journalPath, Buffer.alloc(28));
          }
        }
        return open(path, flags);
      },
    };
    await expect(
      captureSqliteDatabaseSnapshot(database.path, root, undefined, fileSystem),
    ).rejects.toMatchObject({ reason: "integrity" });
  },
);

it("rejects a database changed after its copy but before WAL acquisition", async () => {
  const { database, root } = await fixture(true);
  const initial = await readFile(database.path);
  const initialStat = await lstat(database.path);
  let changed = false;
  const fileSystem: StableArtifactFileSystem = {
    lstat: (path) => lstat(path, { bigint: true }),
    open: async (path, flags) => {
      if (path === database.walPath) {
        const bytes = Buffer.from(initial);
        const offset = bytes.length - 1;
        bytes[offset] = (bytes[offset] ?? 0) ^ 1;
        await writeFile(database.path, bytes);
        await utimes(database.path, initialStat.atime, initialStat.mtime);
        changed = true;
      }
      return open(path, flags);
    },
  };
  await expect(
    captureSqliteDatabaseSnapshot(database.path, root, undefined, fileSystem),
  ).rejects.toMatchObject({ reason: "integrity" });
  expect(changed).toBe(true);
  expect(await readFile(`${root}/database.snapshot`)).toEqual(initial);
});

it.each(["-wal", "-journal"] as const)(
  "rejects a previously absent %s created during database acquisition",
  async (suffix) => {
    const { database, root } = await fixture();
    let created = false;
    const fileSystem: StableArtifactFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      open: async (path, flags) => {
        if (path === database.path) {
          await writeFile(
            `${database.path}${suffix}`,
            "newly selected sidecar",
          );
          created = true;
        }
        return open(path, flags);
      },
    };
    await expect(
      captureSqliteDatabaseSnapshot(database.path, root, undefined, fileSystem),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(created).toBe(true);
  },
);
