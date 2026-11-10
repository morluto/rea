import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import {
  PACKAGE_FILE_FIELDS,
  packageFileMismatch,
  parseDpkgDebFields,
} from "../domain/desktop/debianPackageFile.js";
import type { DesktopPackage } from "../domain/desktop/desktopCapture.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import {
  sameRegularFileState,
  type RegularFileState,
} from "../filesystem/RegularFile.js";
import {
  StableFileHashFailure,
  observeStableFile,
  stableFileHashCause,
} from "../filesystem/StableFileHash.js";
import { hostFileKind, isRefusedRead } from "./HostFileRead.js";
import type { QueryRunner } from "./HostQuery.js";

type PackageFileFacts = Pick<
  DesktopPackage,
  "package_file" | "package_file_reason"
>;

/**
 * The file's SHA-256, size and identity, streamed through one admitted
 * descriptor that must hold still while it is read, or why it could not be
 * read. A close that fails is thrown with the handle's cleanup owner, which
 * fails the capture, even when the capture was also cancelled.
 */
const hashPackageFile = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<
  | {
      readonly sha256: string;
      readonly bytes: number;
      readonly state: RegularFileState;
    }
  | string
> => {
  let lease: AnalysisCleanupLease | undefined;
  try {
    return await observeStableFile(path, {
      ...(signal === undefined ? {} : { signal }),
      retainFailedClose: (owner) => {
        lease = new AnalysisCleanupLease(() => owner.close(), [path]);
      },
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure && lease !== undefined)
      throw new ArtifactFileCleanupFailure(cause, lease);
    signal?.throwIfAborted();
    const read = stableFileHashCause(cause);
    if (!(cause instanceof StableFileHashFailure) || !isRefusedRead(read))
      throw cause;
    return `${path} could not be read: ${read instanceof Error ? read.message : String(read)}`;
  }
};

/**
 * The `.deb` file the caller says installed the application: its control
 * fields from `dpkg-deb --field`, then its SHA-256 and size, recorded only
 * when it holds the installed package's name, version and architecture;
 * otherwise why not. The file itself is never copied.
 */
export const inspectPackageFile = async (
  path: string,
  installed: DesktopPackage,
  runQuery: QueryRunner,
  signal: AbortSignal | undefined,
): Promise<PackageFileFacts> => {
  const refused = (reason: string): PackageFileFacts => ({
    package_file_reason: reason,
  });
  if (
    installed.kind !== "deb" ||
    installed.version === null ||
    installed.architecture === null
  )
    return refused(
      `dpkg reports no installed version of the application (${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}), so ${path} was not matched against it`,
    );
  const regularFile = await hostFileKind(path);
  if (regularFile === null)
    return refused(
      `${path} could not be checked, so it was not read as a file`,
    );
  if (!regularFile) return refused(`${path} is not a regular file`);
  // dpkg-deb and the hash read the file apart; its identity must hold across both.
  const before = await stat(path).catch(() => undefined);
  if (before === undefined) return refused(`${path} could not be read`);
  const outcome = await runQuery(
    "dpkg-deb",
    ["--field", path, ...PACKAGE_FILE_FIELDS],
    signal,
  );
  if (outcome === "missing")
    return refused(
      `dpkg-deb is not installed, so the control fields of ${path} were not read`,
    );
  if (outcome === "failed" || outcome.exitCode !== 0)
    return refused(`dpkg-deb could not read ${path} as a Debian package`);
  const fields = parseDpkgDebFields(outcome.stdout);
  if (fields === undefined)
    return refused(
      `dpkg-deb did not report the Package, Version and Architecture of ${path}`,
    );
  const mismatch = packageFileMismatch(fields, installed);
  if (mismatch !== undefined) return refused(`${path} ${mismatch}`);
  const hashed = await hashPackageFile(path, signal);
  if (typeof hashed === "string") return refused(hashed);
  if (!sameRegularFileState(hashed.state, before))
    return refused(
      `${path} changed while it was read, so its control fields and its hash could describe different files`,
    );
  return {
    package_file: {
      name: basename(path),
      sha256: hashed.sha256,
      size: hashed.bytes,
      ...fields,
    },
  };
};
