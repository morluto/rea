import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, extname } from "node:path";

import { ADB_PROVIDER_IDENTITY } from "./AdbProviderIdentity.js";
import { adbFilesystemErrorCode } from "./AdbFilesystemAdmission.js";
import { displayDevicePath } from "./AdbDeviceOutput.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import {
  regularFileCancellation,
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "../filesystem/OwnedRegularFile.js";
import { RegularFileOperationCancelled } from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type {
  AdbAcquiredFilePartialObservation,
  AdbPackagePullPartialObservation,
} from "../domain/adb/adbDeviceAnalysis.js";
import {
  ArtifactResourceScope,
  AnalysisCleanupLease,
} from "../resources/index.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";

export type AdbFileDigest = Awaited<ReturnType<typeof hashStableFile>>;

/**
 * A pushed file's device-side digest together with its source, so a receipt
 * cannot name `sha256sum` as the source of a digest that was never parsed.
 */
export type AdbDeviceDigest =
  | {
      readonly device_sha256: string;
      readonly device_digest_source: "device_sha256sum";
    }
  | {
      readonly device_sha256: null;
      readonly device_digest_source: "unavailable";
      readonly reason: string;
    };

/** Carry the exact digest owner through caller-specific partial-result mapping. */
export class AdbDigestFailure extends Error {
  constructor(
    readonly fileFailure:
      | RegularFileCleanupFailure<AdbFileDigest>
      | RegularFileCancelled<AdbFileDigest>,
    readonly bindCleanupError: (error: AnalysisError) => void,
  ) {
    super(fileFailure.message, { cause: fileFailure });
  }
}

export const hashAdbFile = async (
  path: string,
  operation: string,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
) => {
  let closeLease: AnalysisCleanupLease | undefined;
  try {
    return await hashStableFile(path, {
      ...(signal === undefined ? {} : { signal }),
      retainFailedClose: (handle) => {
        closeLease = new AnalysisCleanupLease(() => handle.close(), [path]);
        resources.retain({
          kind: "lease",
          resource: `${path} (ADB digest handle)`,
          lease: closeLease,
        });
      },
    });
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure ||
      cause instanceof RegularFileCancelled
    )
      throw new AdbDigestFailure(
        cause as
          | RegularFileCleanupFailure<AdbFileDigest>
          | RegularFileCancelled<AdbFileDigest>,
        (error) => {
          closeLease?.bindCleanupError(error);
        },
      );
    if (cause instanceof RegularFileOperationCancelled)
      throw cancelledBy(operation, carriedReason(cause.reason));
    throw cause;
  }
};

/** Report a pulled file's digest that was cancelled or whose handle stayed open. */
export const adbDigestError = (
  cause: AdbDigestFailure,
  operation: string,
  partialObservation:
    | AdbAcquiredFilePartialObservation
    | AdbPackagePullPartialObservation,
): AnalysisError => {
  const digestFailure = cause.fileFailure;
  const digestOutcome = digestFailure.outcome;
  if (digestOutcome.kind === "completed")
    partialObservation = partialObservationWithDigest(
      partialObservation,
      digestOutcome.value,
    );
  if (digestFailure instanceof RegularFileCancelled)
    return cancelledBy(operation, carriedReason(digestFailure.reason), {
      partialObservation,
    });
  const resource = `${digestFailure.path} (ADB digest handle)`;
  const reason = errorMessage(digestFailure.cleanupCause);
  const cleanup = new ProviderCleanupError(
    ADB_PROVIDER_IDENTITY.id,
    [resource],
    { reason },
    {
      operation,
      cause: digestFailure,
      partialObservation,
    },
  );
  const primaryCause =
    digestOutcome.kind === "failed" ? digestOutcome.cause : undefined;
  const cancellation = regularFileCancellation(digestFailure);
  if (cancellation !== undefined) {
    const error = cancelledBy(operation, carriedReason(cancellation.reason), {
      cleanup: { reason, resources: [resource] },
      partialObservation,
    });
    cause.bindCleanupError(error);
    return error;
  }

  const primary =
    primaryCause instanceof AnalysisError
      ? primaryCause
      : new AnalysisOutputError(
          operation,
          `The pulled file could not be fully digested or its handle could not be closed: ${digestFailure.path}`,
          {
            cause:
              digestOutcome.kind === "failed" ? primaryCause : digestFailure,
            partialObservation,
          },
        );
  primary.retainPartialObservation(partialObservation);
  const error = analysisErrorWithCleanupFailure(primary, cleanup, operation);
  cause.bindCleanupError(error);
  return error;
};

const partialObservationWithDigest = (
  observation:
    | AdbAcquiredFilePartialObservation
    | AdbPackagePullPartialObservation,
  digest: AdbFileDigest,
): AdbAcquiredFilePartialObservation | AdbPackagePullPartialObservation => {
  if (observation.operation === "pull_adb_file") {
    const { result } = observation;
    if (!("digest_status" in result)) return observation;
    return {
      ...observation,
      result: {
        client: result.client,
        serial: result.serial,
        local_path: result.local_path,
        device_path: result.device_path,
        bytes: digest.bytes,
        sha256: digest.sha256,
      },
    };
  }
  if (observation.operation === "collect_adb_bugreport") {
    const { result } = observation;
    if (!("digest_status" in result)) return observation;
    return {
      ...observation,
      result: {
        client: result.client,
        serial: result.serial,
        local_path: result.local_path,
        adb_reported_path: result.adb_reported_path,
        bytes: digest.bytes,
        sha256: digest.sha256,
      },
    };
  }
  return observation;
};

export const syncStagedAdbFile = async (
  path: string,
  resources: ArtifactResourceScope,
  operation: string,
): Promise<void> => {
  let owner: OwnedFileHandle | undefined;
  let primary: unknown;
  try {
    owner = new OwnedFileHandle(await open(path, "r+"));
    await owner.handle.sync();
  } catch (cause: unknown) {
    primary = cause;
  }
  if (owner === undefined) {
    if (primary !== undefined) throw primary;
    return;
  }
  const resource = `${path} (ADB staged-output handle)`;
  const stagedOwner = owner;
  const closeLease = new AnalysisCleanupLease(
    () => stagedOwner.close(),
    [resource],
  );
  const released = await resources.release({
    kind: "lease",
    resource,
    lease: closeLease,
  });
  if (released.kind === "failed") {
    const cleanup = new ProviderCleanupError(
      ADB_PROVIDER_IDENTITY.id,
      [resource],
      {
        reason: errorMessage(released.cause),
      },
      { operation, cause: released.cause },
    );
    let reported: AnalysisError;
    if (primary !== undefined) {
      const failure = new AnalysisOutputError(
        operation,
        `The staged ADB output could not be synchronized: ${path}`,
        { cause: primary },
      );
      reported = analysisErrorWithCleanupFailure(failure, cleanup, operation);
    } else {
      reported = cleanup;
    }
    closeLease.bindCleanupError(reported);
    throw reported;
  }
  if (primary !== undefined) throw primary;
};

/** Materialize the caller's output directory, refusing existing files inside. */
export const prepareOutputDirectory = async (
  operation: string,
  directory: string,
): Promise<Result<string, AnalysisError>> => {
  const root = absoluteCallerPath(directory);
  try {
    await mkdir(root, { recursive: true });
    await access(root, fsConstants.W_OK);
  } catch (cause) {
    const code = adbFilesystemErrorCode(cause);
    if (code === "EEXIST" || code === "ENOTDIR")
      return err(
        new AnalysisInputError(operation, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message: "The selected output path or a parent is not a directory.",
            observed: { path: directory, code },
          },
        ]),
      );
    return err(
      new AnalysisOutputError(
        operation,
        `The output directory is not writable or could not be created: ${root}`,
        { cause },
      ),
    );
  }
  return ok(root);
};

export const refuseExistingTarget = async (
  operation: string,
  path: string,
): Promise<AnalysisError | undefined> => {
  if (
    await lstat(path).then(
      () => true,
      () => false,
    )
  )
    return new AnalysisOutputError(
      operation,
      `The output file already exists: ${path}`,
    );
  return undefined;
};

export const hardLinksUnsupported = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV"].includes(
    String(cause.code),
  );

export interface ScreenPublicationCloseFailure {
  readonly cause: unknown;
  readonly resource: string;
  bindCleanupError(error: ProviderCleanupError): void;
}

/** Exclusive-create fallback for filesystems that cannot hard-link staged files. */
export const publishScreenExclusively = async (
  outputPath: string,
  bytes: Buffer,
  resources: ArtifactResourceScope,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<ScreenPublicationCloseFailure | undefined> => {
  if (signal?.aborted === true) throw cancelledBy(operation, signal);
  const output = await open(outputPath, "wx", 0o600);
  // Successful exclusive creation is this fallback's cutoff. Finish and sync
  // the visible file despite later cancellation so its receipt remains known.
  const ownedOutput = new OwnedFileHandle(output);
  const handleResource = `${outputPath} (ADB publication handle)`;
  const closeOnly = new AnalysisCleanupLease(
    () => ownedOutput.close(),
    [handleResource],
  );
  const removeOutput = async (
    expected: Awaited<ReturnType<typeof output.stat>>,
  ): Promise<void> => {
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(outputPath);
    } catch (cause: unknown) {
      if (cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")
        return;
      throw cause;
    }
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mode !== expected.mode
    )
      throw new Error(
        `The screen output changed before cleanup: ${outputPath}`,
      );
    await rm(outputPath);
  };
  let rollbackIdentity: Awaited<ReturnType<typeof output.stat>> | undefined;
  const inspectCloseAndRollback = new AnalysisCleanupLease(async () => {
    rollbackIdentity ??= await output.stat();
    await ownedOutput.close();
    await removeOutput(rollbackIdentity);
  });
  let identity: Awaited<ReturnType<typeof output.stat>>;
  try {
    identity = await output.stat();
  } catch (cause: unknown) {
    resources.retain({
      kind: "lease",
      resource: `${outputPath} (screen output and descriptor)`,
      lease: inspectCloseAndRollback,
    });
    const error = new ProviderCleanupError(
      ADB_PROVIDER_IDENTITY.id,
      [handleResource, outputPath],
      {
        reason:
          "The newly created screen output identity could not be established; its descriptor remains owned for cleanup retry",
      },
      { operation, cause },
    );
    inspectCloseAndRollback.bindCleanupError(error);
    throw error;
  }
  let writeFailure: { readonly cause: unknown } | undefined;
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (cause: unknown) {
    writeFailure = { cause };
  }
  if (writeFailure === undefined) {
    try {
      await ownedOutput.close();
      return undefined;
    } catch (cause: unknown) {
      resources.retain({
        kind: "lease",
        resource: handleResource,
        lease: closeOnly,
      });
      return {
        cause,
        resource: handleResource,
        bindCleanupError(error) {
          closeOnly.bindCleanupError(error);
        },
      };
    }
  }

  const rollback = new AnalysisCleanupLease(async () => {
    await ownedOutput.close();
    await removeOutput(identity);
  });
  try {
    await ownedOutput.close();
  } catch (closeCause: unknown) {
    resources.retain({ kind: "lease", resource: outputPath, lease: rollback });
    const error = new ProviderCleanupError(
      ADB_PROVIDER_IDENTITY.id,
      [outputPath],
      { reason: errorMessage(closeCause) },
      {
        operation,
        cause: new AggregateError(
          [writeFailure.cause, closeCause],
          "Screen output write and descriptor cleanup failed",
          { cause: writeFailure.cause },
        ),
      },
    );
    rollback.bindCleanupError(error);
    throw error;
  }
  const removed = await resources.release({
    kind: "lease",
    resource: outputPath,
    lease: rollback,
  });
  if (removed.kind === "failed") {
    const error = new ProviderCleanupError(
      ADB_PROVIDER_IDENTITY.id,
      [outputPath],
      { reason: errorMessage(removed.cause) },
      {
        operation,
        cause: new AggregateError(
          [writeFailure.cause, removed.cause],
          "Screen output write and rollback failed",
          { cause: writeFailure.cause },
        ),
      },
    );
    rollback.bindCleanupError(error);
    throw error;
  }
  throw writeFailure.cause;
};

/** Publish an ADB-produced archive without replacing an existing caller file. */
export const publishBugreport = async (
  source: string,
  directory: string,
): Promise<string> => {
  const fileName = basename(source);
  const extension = extname(fileName);
  const stem =
    extension === "" ? fileName : fileName.slice(0, -extension.length);
  for (let suffix = 0; ; suffix += 1) {
    const destination = appendCallerPath(
      directory,
      suffix === 0 ? fileName : `${stem} (${String(suffix)})${extension}`,
    );
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      return destination;
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
        continue;
      throw cause;
    }
  }
};

export type AdbRuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;

/** A root lease releases its children before removing their containing root. */
export const runtimeRootLease = (
  root: AdbRuntimeRoot,
  children: ArtifactResourceScope,
): AnalysisCleanupLease =>
  new AnalysisCleanupLease(
    async () => {
      await children.close();
      await root.close();
    },
    {
      get cleanupResources() {
        return [root.path, ...children.cleanupResources];
      },
    },
  );

export interface PendingOutputDirectoryCleanup {
  readonly operation: "pull_adb_package" | "collect_adb_bugreport";
  readonly path: string;
  readonly primary: AnalysisError;
  readonly remove: () => Promise<void>;
  readonly resources?: () => readonly string[];
  readonly lease: AnalysisCleanupLease;
}

export interface OutputDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export const removeOwnedOutputDirectory = async (
  path: string,
  identity: OutputDirectoryIdentity | undefined,
): Promise<void> => {
  if (identity === undefined)
    throw new Error(
      `Cannot verify the created output directory identity; refusing to remove ${path}`,
    );
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && Reflect.get(cause, "code") === "ENOENT")
      return;
    throw cause;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.mode !== identity.mode
  )
    throw new Error(
      `The created output directory was replaced or changed; refusing to remove ${path}`,
    );
  await rm(path, { recursive: true, force: true });
};

export const reservePackageDestinations = async (
  operation: string,
  packageName: string,
  packageDirectory: string,
  entries: readonly {
    readonly file_name: string;
    readonly device_path: string;
  }[],
  capturedOutput: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
  },
): Promise<AnalysisOutputError | undefined> => {
  const reservations: {
    readonly path: string;
    readonly file_name: string;
    readonly device_path: string;
    readonly identity: OutputDirectoryIdentity;
  }[] = [];
  for (const entry of entries) {
    const path = appendCallerPath(packageDirectory, entry.file_name);
    try {
      await mkdir(path);
      const created = await lstat(path);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(`Could not reserve local filename ${entry.file_name}`);
      reservations.push({
        path,
        file_name: entry.file_name,
        device_path: entry.device_path,
        identity: {
          dev: created.dev,
          ino: created.ino,
          mode: created.mode,
        },
      });
    } catch (cause: unknown) {
      const errorCode =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : null;
      return new AnalysisOutputError(
        operation,
        "local_destination_unavailable",
        {
          cause,
          capturedOutput,
          userMessage: `pm path for ${packageName} reported ${displayDevicePath(entry.device_path)}, whose file name ${displayDevicePath(entry.file_name)} cannot be written to a unique local destination (${errorCode ?? "unknown error"}). No APK was pulled.`,
          remediationAction:
            "Review details.diagnostics and details.captured_output for the refused destination. Correct the output filesystem conflict before retrying; REA does not rename APKs.",
          diagnostics: {
            package_name: packageName,
            device_path: entry.device_path,
            file_name: entry.file_name,
            error_code: errorCode,
          },
        },
      );
    }
  }
  for (const reservation of reservations) {
    try {
      const current = await lstat(reservation.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== reservation.identity.dev ||
        current.ino !== reservation.identity.ino ||
        current.mode !== reservation.identity.mode
      )
        throw new Error(
          `The local filename reservation changed before release: ${reservation.path}`,
        );
      await rmdir(reservation.path);
    } catch (cause: unknown) {
      const errorCode =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : null;
      return new AnalysisOutputError(
        operation,
        "local_destination_unavailable",
        {
          cause,
          capturedOutput,
          userMessage: `Could not release the local filename reservation for ${displayDevicePath(reservation.device_path)} (${errorCode ?? "unknown error"}); no APK was pulled.`,
          remediationAction:
            "Review details.diagnostics and details.captured_output for the refused destination. Correct the output filesystem conflict before retrying; REA does not rename APKs.",
          diagnostics: {
            package_name: packageName,
            device_path: reservation.device_path,
            file_name: reservation.file_name,
            error_code: errorCode,
          },
        },
      );
    }
  }
  return undefined;
};
