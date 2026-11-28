import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { readRegularFile } from "../process/RegularFileRead.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { systemCodeFromError } from "../kernel/reportedSystemCode.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

export interface RecoveryBackupSelection {
  readonly backupPath: string;
  readonly present: boolean;
}

export interface RecoveryBackupSelectionFailure {
  readonly kind: "unreadable" | "occupied";
  readonly path: string;
  readonly detail: string;
}

/** Select a persistent snapshot only when its bytes match this transaction's original. */
export const selectCurrentRecoveryBackup = async (
  firstBackupPath: string,
  original: string | Buffer,
  resources?: ArtifactResourceScope,
): Promise<Result<RecoveryBackupSelection, RecoveryBackupSelectionFailure>> => {
  const expected = Buffer.isBuffer(original)
    ? original
    : Buffer.from(original, "utf8");
  const inspect = async (
    path: string,
  ): Promise<
    Result<RecoveryBackupSelection, RecoveryBackupSelectionFailure>
  > => {
    let bytes: Buffer;
    try {
      bytes = await readRegularFile(path, {
        symlinks: "reject",
        ...(resources === undefined ? {} : { resources }),
      });
    } catch (cause: unknown) {
      if (cause instanceof RegularFileCleanupFailure) throw cause;
      if (systemCodeFromError(cause) === "ENOENT")
        return ok({ backupPath: path, present: false });
      return err({
        kind: "unreadable",
        path,
        detail: `The recovery backup could not be checked: ${errorMessage(cause)}`,
      });
    }
    if (bytes.equals(expected)) return ok({ backupPath: path, present: true });
    return err({
      kind: "occupied",
      path,
      detail: `The recovery path already contains different data: ${path}`,
    });
  };

  const first = await inspect(firstBackupPath);
  if (first.ok || first.error.kind !== "occupied") return first;
  return inspect(`${firstBackupPath}.${sha256Hex(expected)}.recovery`);
};

export interface RecoveryBackupPreservationFailure {
  readonly kind: RecoveryBackupSelectionFailure["kind"] | "copy" | "unverified";
  readonly path: string;
  readonly detail: string;
}

const copyExclusive = (source: string, destination: string): Promise<void> =>
  copyFile(source, destination, fsConstants.COPYFILE_EXCL);

export interface RecoveryBackupPreservationOptions {
  /** Copy without replacing an existing destination; reject one with EEXIST. */
  readonly copy?: (source: string, destination: string) => Promise<void>;
  /** Scope that retains a backup read whose handle cleanup failed. */
  readonly resources?: ArtifactResourceScope;
}

/**
 * Preserve a transaction's original bytes before it edits the file: keep a
 * matching first backup, otherwise copy them to the content-addressed recovery
 * path without replacing an earlier file, then verify the selected snapshot.
 */
export const preserveCurrentRecoveryBackup = async (
  firstBackupPath: string,
  source: string,
  original: string | Buffer,
  { copy = copyExclusive, resources }: RecoveryBackupPreservationOptions = {},
): Promise<Result<string, RecoveryBackupPreservationFailure>> => {
  const selection = await selectCurrentRecoveryBackup(
    firstBackupPath,
    original,
    resources,
  );
  if (!selection.ok) return selection;
  const { backupPath } = selection.value;
  if (!selection.value.present) {
    try {
      await copy(source, backupPath);
    } catch (cause: unknown) {
      if (systemCodeFromError(cause) !== "EEXIST")
        return err({
          kind: "copy",
          path: backupPath,
          detail: `The recovery backup could not be written: ${errorMessage(cause)}`,
        });
    }
  }
  const verified = await selectCurrentRecoveryBackup(
    firstBackupPath,
    original,
    resources,
  );
  if (!verified.ok) return verified;
  if (verified.value.backupPath !== backupPath || !verified.value.present)
    return err({
      kind: "unverified",
      path: backupPath,
      detail: `The recovery backup does not match the configuration it preserves: ${backupPath}`,
    });
  return ok(backupPath);
};
