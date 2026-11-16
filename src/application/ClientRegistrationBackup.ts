import { chmodSync, lstatSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  preserveCurrentRecoveryBackup,
  type RecoveryBackupPreservationFailure,
  type RecoveryBackupPreservationOptions,
} from "./SetupRecoveryBackup.js";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const restrictExistingBackup = (
  backupPath: string,
): Result<void, RecoveryBackupPreservationFailure> => {
  let existing: ReturnType<typeof lstatSync>;
  try {
    existing = lstatSync(backupPath);
  } catch (cause: unknown) {
    if (isMissing(cause)) return ok(undefined);
    return err({
      kind: "unreadable",
      path: backupPath,
      detail: `The existing client configuration backup could not be checked: ${errorMessage(cause)}`,
    });
  }
  if (!existing.isFile())
    return err({
      kind: "occupied",
      path: backupPath,
      detail: "The existing client configuration backup is not a regular file.",
    });
  try {
    chmodSync(backupPath, 0o600);
  } catch (cause: unknown) {
    return err({
      kind: "unreadable",
      path: backupPath,
      detail: `The existing client configuration backup permissions could not be secured: ${errorMessage(cause)}`,
    });
  }
  return ok(undefined);
};

const copyPrivateBackup = async (
  sourcePath: string,
  backupPath: string,
): Promise<void> => {
  await writeFile(backupPath, await readFile(sourcePath), {
    flag: "wx",
    mode: 0o600,
  });
};

/**
 * Preserve a configuration's original bytes in an owner-only (0600) backup,
 * restricting any backup already selected for them, so a private profile's
 * contents never sit in a more permissive copy beside the requested path.
 */
export const preservePrivateRecoveryBackup = async (
  firstBackupPath: string,
  source: string,
  original: string,
  resources?: RecoveryBackupPreservationOptions["resources"],
): Promise<Result<string, RecoveryBackupPreservationFailure>> => {
  const firstRestricted = restrictExistingBackup(firstBackupPath);
  if (!firstRestricted.ok) return firstRestricted;
  const preserved = await preserveCurrentRecoveryBackup(
    firstBackupPath,
    source,
    original,
    {
      copy: copyPrivateBackup,
      ...(resources === undefined ? {} : { resources }),
    },
  );
  if (!preserved.ok) return preserved;
  const selectedRestricted = restrictExistingBackup(preserved.value);
  if (!selectedRestricted.ok) return selectedRestricted;
  return ok(preserved.value);
};

export const writeClientRegistrationBackup = (
  settingsPath: string,
  settingsText: string,
): Promise<Result<string, RecoveryBackupPreservationFailure>> =>
  preservePrivateRecoveryBackup(
    `${settingsPath}.rea.backup`,
    settingsPath,
    settingsText,
  );
