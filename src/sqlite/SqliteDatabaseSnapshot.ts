import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { SQLITE_PROVIDER_IDENTITY } from "../domain/sqlite/SqliteProviderIdentity.js";
import {
  withArtifactFileHandle,
  assertArtifactReadActive,
} from "../artifacts/ArtifactFileOperation.js";
import {
  completedStableArtifact,
  readStableArtifact,
  type StableArtifactSnapshot,
  type StableArtifactFileSystem,
} from "../artifacts/readStableArtifact.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

const fileSystem: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
  realpath,
};

type SnapshotMemberRole = "database" | "wal";
type CompletedSnapshotMember = {
  readonly role: SnapshotMemberRole;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

/** Individual source reads do not establish that the whole file set is consistent. */
export class SqliteSnapshotAcquisitionFailure extends Error {
  readonly _tag = "SqliteSnapshotAcquisitionFailure";
  readonly completedMembers: readonly CompletedSnapshotMember[];

  constructor(
    readonly operationCause: unknown,
    members: readonly CompletedSnapshotMember[],
  ) {
    super(
      operationCause instanceof Error
        ? operationCause.message
        : "SQLite source acquisition failed after completed member reads",
      { cause: operationCause },
    );
    this.name = this._tag;
    this.completedMembers = members.map((member) => ({ ...member }));
  }
}

/** Probe a generated sibling only after the caller-selected database is observed. */
const optionalSidecarStat = async (
  path: string,
  databasePath: string,
  observedDatabase: BigIntStats,
  member: "WAL" | "rollback journal",
  selectedFileSystem: StableArtifactFileSystem,
): Promise<BigIntStats | null> => {
  let observedSidecar: BigIntStats | null;
  try {
    observedSidecar = await optionalStat(path, selectedFileSystem);
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENAMETOOLONG"
    ) {
      const currentDatabase = await duringAcquisition(databasePath, () =>
        optionalStat(databasePath, selectedFileSystem),
      );
      if (!sameState(observedDatabase, currentDatabase))
        throw new ArtifactReaderFailure(
          "integrity",
          `SQLite snapshot file set changed before sidecar inspection: ${databasePath}`,
          { cause },
        );
      const remedy =
        "Use the application's supported consistent offline export or copy workflow to move the complete known database file set to a shorter path. Do not rename a live database or omit its WAL or journal.";
      throw new AnalysisCapabilityUnavailableError(
        SQLITE_PROVIDER_IDENTITY.id,
        "inspect_sqlite_database",
        `Cannot safely address the derived SQLite ${member} path (${String(cause.code)}): ${path}`,
        {
          cause,
          userMessage: `The derived SQLite ${member} path is too long to inspect safely (ENAMETOOLONG). ${remedy}`,
        },
      );
    }
    throw cause;
  }
  return observedSidecar;
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
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite snapshot file set changed during acquisition: ${path}`,
        { cause },
      );
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit") {
      const changed = new ArtifactReaderFailure(
        "integrity",
        `SQLite snapshot file set exceeded its observed size during acquisition: ${path}`,
        {
          cause,
          ...(cause.partialObservation === undefined
            ? {}
            : { partialObservation: cause.partialObservation }),
        },
        cause.details,
      );
      if (cause.cleanup !== undefined)
        throw ArtifactReaderFailure.withCleanup(
          changed,
          cause.cleanup,
          cause.partialObservation,
        );
      throw changed;
    }
    throw cause;
  }
};

/**
 * Only the selected database may be reselected through its resolved target.
 * A derived WAL is not a caller input, so its refusal advises a consistent
 * regular-file snapshot instead of retrying `path` with the WAL target.
 */
const derivedWalRefusal = (
  cause: unknown,
  walPath: string,
  databasePath: string,
): unknown =>
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "path" &&
  cause.cleanup === undefined &&
  cause.userMessage === undefined
    ? new ArtifactReaderFailure("path", cause.message, {
        cause,
        userMessage: `The derived SQLite WAL is not a regular file (for example, it is a symlink): ${walPath}. REA does not follow WAL symlinks or accept a WAL as the selected database. Use the application's supported consistent offline export or copy workflow to create a snapshot where ${databasePath} and its WAL are regular files, then select that database.`,
      })
    : cause;

const readObservedArtifact = (
  role: SnapshotMemberRole,
  databasePath: string,
  path: string,
  observed: BigIntStats,
  maximumBytes: number,
  selectedFileSystem: StableArtifactFileSystem,
  resourceScope: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  // Derived sidecars must not borrow the selected database's retry advice.
  const resolveTarget =
    role === "database"
      ? selectedFileSystem.realpath?.bind(selectedFileSystem)
      : undefined;
  const read = duringAcquisition(path, () =>
    readStableArtifact(
      path,
      maximumBytes,
      signal,
      {
        open: (selectedPath, flags) =>
          selectedFileSystem.open(selectedPath, flags),
        // Names a refused symlink's target; test doubles may omit it.
        ...(resolveTarget === undefined ? {} : { realpath: resolveTarget }),
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
  return role === "database"
    ? read
    : read.catch((cause: unknown) => {
        throw derivedWalRefusal(cause, path, databasePath);
      });
};

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
  await withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
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
          assertArtifactReadActive(signal);
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
    },
  );
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
  const walPath = `${path}-wal`;
  const completedMembers: CompletedSnapshotMember[] = [];
  const recordMember = (
    role: SnapshotMemberRole,
    snapshot: StableArtifactSnapshot,
  ) => {
    completedMembers.push({
      role,
      path: role === "database" ? path : walPath,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
    });
    return snapshot;
  };
  const readMember = async (
    role: SnapshotMemberRole,
    observed: BigIntStats,
    maximumBytes: number,
  ) => {
    try {
      return recordMember(
        role,
        await readObservedArtifact(
          role,
          path,
          role === "database" ? path : walPath,
          observed,
          maximumBytes,
          selectedFileSystem,
          resourceScope,
          signal,
        ),
      );
    } catch (cause: unknown) {
      const completed = completedStableArtifact(cause);
      if (completed !== undefined) recordMember(role, completed);
      throw cause;
    }
  };
  try {
    assertArtifactReadActive(signal);
    const journalPath = `${path}-journal`;
    const paths = [path, walPath, journalPath] as const;
    const database = await optionalStat(path, selectedFileSystem);
    if (database === null) throw missingDatabase(path);
    const wal = await optionalSidecarStat(
      walPath,
      path,
      database,
      "WAL",
      selectedFileSystem,
    );
    const journal = await optionalSidecarStat(
      journalPath,
      path,
      database,
      "rollback journal",
      selectedFileSystem,
    );
    const before = [database, wal, journal] as const;
    const selectedSize = database.size + (wal?.size ?? 0n);
    if (selectedSize > BigInt(SQLITE_DATABASE_LIMITS.inputBytes))
      throw new AnalysisResourceConstraintError(
        "inspect_sqlite_database",
        "file-size",
        `Selected SQLite database and WAL total ${selectedSize.toString()} bytes, exceeding the combined ${String(SQLITE_DATABASE_LIMITS.inputBytes)}-byte offline snapshot budget: ${path}`,
        {
          sqlite_snapshot_input_bytes: SQLITE_DATABASE_LIMITS.inputBytes,
          observed_sqlite_snapshot_input_bytes: selectedSize.toString(),
        },
        {
          remediationAction: `Use the application's supported export workflow to create a consistent, smaller offline SQLite snapshot containing only the relevant data, then inspect that snapshot. REA will not truncate or modify the selected source. The combined input allowance is ${String(SQLITE_DATABASE_LIMITS.inputBytes)} bytes. This release has no runtime override. worker_timeout_ms does not raise it.`,
        },
      );
    if (journal !== null)
      await verifyInactiveJournal(
        `${path}-journal`,
        journal,
        selectedFileSystem,
        resourceScope,
        "initial",
        signal,
      );
    const snapshotPath = join(root, "database.snapshot");
    const captured = await readMember(
      "database",
      database,
      SQLITE_DATABASE_LIMITS.inputBytes,
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
      const capturedWal = await readMember(
        "wal",
        wal,
        SQLITE_DATABASE_LIMITS.inputBytes - artifact.bytes,
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
    if (journal !== null)
      await verifyInactiveJournal(
        `${path}-journal`,
        journal,
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
    assertArtifactReadActive(signal);
    return { snapshotPath, artifact, wal: walArtifact };
  } catch (cause: unknown) {
    if (completedMembers.length === 0) throw cause;
    throw new SqliteSnapshotAcquisitionFailure(cause, completedMembers);
  }
};
