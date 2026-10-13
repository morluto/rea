import { lstat, open, writeFile } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  readStableArtifact,
  type StableArtifactFileSystem,
} from "../artifacts/readStableArtifact.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

const fileSystem: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};
const optionalStat = async (
  path: string,
  selectedFileSystem: StableArtifactFileSystem,
): Promise<BigIntStats | null> => {
  try {
    return await selectedFileSystem.lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
};
const sameState = (
  before: BigIntStats | null,
  after: BigIntStats | null,
): boolean =>
  before === null || after === null
    ? before === after
    : before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs;

const duringAcquisition = async <T>(
  path: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite snapshot file set changed during acquisition: ${path}`,
        { cause },
      );
    throw cause;
  }
};

const readObservedArtifact = (
  path: string,
  observed: BigIntStats,
  maximumBytes: number,
  selectedFileSystem: StableArtifactFileSystem,
  resourceScope: ArtifactResourceScope,
  signal?: AbortSignal,
) =>
  duringAcquisition(path, () =>
    readStableArtifact(
      path,
      maximumBytes,
      signal,
      {
        open: (selectedPath, flags) =>
          selectedFileSystem.open(selectedPath, flags),
        lstat: async (selectedPath) => {
          const current = await selectedFileSystem.lstat(selectedPath);
          if (!sameState(observed, current))
            throw new ArtifactReaderFailure(
              "integrity",
              `SQLite snapshot file set changed during acquisition: ${selectedPath}`,
            );
          return current;
        },
      },
      resourceScope,
    ),
  );

const verifyInactiveJournal = async (
  path: string,
  before: BigIntStats,
  selectedFileSystem: StableArtifactFileSystem,
  resourceScope: ArtifactResourceScope,
  phase: "initial" | "after-copy",
  signal?: AbortSignal,
): Promise<void> => {
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular journal without a symlink: ${path}`,
    );
  const file = await duringAcquisition(path, () =>
    selectedFileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  const owner = new OwnedFileHandle(file);
  let failure: unknown;
  try {
    if (!sameState(before, await file.stat({ bigint: true })))
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite journal changed before open: ${path}`,
      );
    // TRUNCATE commits leave an empty file; PERSIST commits zero the complete
    // 28-byte fixed header. A new active journal may zero only its magic bytes.
    const header = Buffer.alloc(28);
    let bytesRead = 0;
    if (before.size > 0n) {
      while (bytesRead < header.length) {
        signal?.throwIfAborted();
        const read = await file.read(
          header,
          bytesRead,
          header.length - bytesRead,
          bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
    }
    if (!sameState(before, await file.stat({ bigint: true })))
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite journal changed during inspection: ${path}`,
      );
    if (
      before.size !== 0n &&
      (bytesRead !== header.length || header.some((byte) => byte !== 0))
    )
      throw new ArtifactReaderFailure(
        phase === "initial" ? "format" : "integrity",
        phase === "initial"
          ? `Rollback journal may require recovery: ${path}. Supply a clean offline snapshot; only empty journals or a fully zeroed header are supported.`
          : `Rollback journal became active or malformed during database acquisition: ${path}`,
      );
  } catch (cause: unknown) {
    failure = cause;
    throw cause;
  } finally {
    const cleanup = await resourceScope.release({
      kind: "file-handle",
      resource: path,
      handle: owner,
    });
    if (cleanup.kind === "failed")
      throw ArtifactReaderFailure.withCleanup(
        failure ?? cleanup.cause,
        ArtifactReaderFailure.cleanupObservation(cleanup.cause, path),
      );
  }
};

// Absence is a caller value to correct, not malformed path or content.
const missingDatabase = (path: string): AnalysisInputError =>
  new AnalysisInputError("inspect_sqlite_database", undefined, [
    {
      path: ["path"],
      reason: "invalid_value",
      message: `Selected SQLite database does not exist: ${path}`,
    },
  ]);

/** Freeze a stable offline file set without ever opening the source through SQLite. */
export const captureSqliteDatabaseSnapshot = async (
  path: string,
  root: string,
  resourceScope: ArtifactResourceScope,
  signal?: AbortSignal,
  selectedFileSystem: StableArtifactFileSystem = fileSystem,
) => {
  signal?.throwIfAborted();
  const paths = [path, `${path}-wal`, `${path}-journal`];
  const before = await Promise.all(
    paths.map((path) => optionalStat(path, selectedFileSystem)),
  );
  const database = before[0];
  const wal = before[1];
  if (database === undefined || wal === undefined || before[2] === undefined)
    throw new Error("Incomplete database file-set observation");
  if (database === null) throw missingDatabase(path);
  if (before[2] !== null)
    await verifyInactiveJournal(
      `${path}-journal`,
      before[2],
      selectedFileSystem,
      resourceScope,
      "initial",
      signal,
    );
  const selectedSize = database.size + (wal?.size ?? 0n);
  if (selectedSize > BigInt(SQLITE_DATABASE_LIMITS.inputBytes))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected SQLite database and WAL exceed the combined ${String(SQLITE_DATABASE_LIMITS.inputBytes)}-byte snapshot budget: ${path}`,
    );
  const snapshotPath = join(root, "database.snapshot");
  const captured = await readObservedArtifact(
    path,
    database,
    SQLITE_DATABASE_LIMITS.inputBytes,
    selectedFileSystem,
    resourceScope,
    signal,
  );
  await writeFile(snapshotPath, captured.bytes, {
    flag: "wx",
    mode: 0o600,
    ...(signal === undefined ? {} : { signal }),
  });
  const artifact = {
    path,
    sha256: captured.sha256,
    bytes: captured.bytes.length,
  };
  let walArtifact: typeof artifact | null = null;
  if (wal !== null) {
    const capturedWal = await readObservedArtifact(
      `${path}-wal`,
      wal,
      SQLITE_DATABASE_LIMITS.inputBytes - artifact.bytes,
      selectedFileSystem,
      resourceScope,
      signal,
    );
    await writeFile(`${snapshotPath}-wal`, capturedWal.bytes, {
      flag: "wx",
      mode: 0o600,
      ...(signal === undefined ? {} : { signal }),
    });
    walArtifact = {
      path: `${path}-wal`,
      sha256: capturedWal.sha256,
      bytes: capturedWal.bytes.length,
    };
  }
  // Identity alone does not establish an inactive journal when timestamps are
  // coarse. Re-read the header after copying, using the same validity owner.
  if (before[2] !== null)
    await verifyInactiveJournal(
      `${path}-journal`,
      before[2],
      selectedFileSystem,
      resourceScope,
      "after-copy",
      signal,
    );
  const after = await Promise.all(
    paths.map((path) =>
      duringAcquisition(path, () => optionalStat(path, selectedFileSystem)),
    ),
  );
  for (const [index, expected] of before.entries())
    if (!sameState(expected, after[index] ?? null))
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite snapshot file set changed during acquisition: ${paths[index] ?? path}`,
      );
  signal?.throwIfAborted();
  return { snapshotPath, artifact, wal: walArtifact };
};
