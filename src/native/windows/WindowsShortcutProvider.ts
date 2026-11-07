import { lstat, open } from "node:fs/promises";
import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  readStableArtifact,
  type StableArtifactFileSystem,
  type StableArtifactSnapshot,
} from "../../artifacts/readStableArtifact.js";
import { fileSnapshotPartialObservationSchema } from "../../domain/fileSnapshotObservation.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { WindowsShortcutPort } from "../../application/binaryDiagnostics/WindowsShortcutPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_WINDOWS_SHORTCUT_EXTRA_DATA_BLOCKS,
  MAX_INSPECT_WINDOWS_SHORTCUT_FILE_BYTES,
  MAX_INSPECT_WINDOWS_SHORTCUT_ID_LIST_ITEMS,
  MAX_INSPECT_WINDOWS_SHORTCUT_STRING_BYTES,
  type InspectWindowsShortcutInput,
} from "../../domain/native/windowsShortcut.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { WINDOWS_SHORTCUT_PROVIDER } from "../../domain/investigationProviders.js";
import {
  WindowsShortcutFormatFailure,
  WindowsShortcutResourceFailure,
  type WindowsShortcutSelectedBoundary,
} from "./WindowsShortcut.errors.js";
import { parseWindowsShortcut } from "./WindowsShortcutParser.js";

const OPERATION = "inspect_windows_shortcut";

/** A path that starts with two separators: UNC, extended UNC, or another device path. */
const HOST_PREFIXED_PATH = /^[\\/]{2}/u;
/** An extended or device form of a drive path, such as `\\?\C:\x`, which stays on this host. */
const LOCAL_DRIVE_DEVICE_PATH = /^[\\/]{2}[?.][\\/][A-Za-z]:(?:[\\/]|$)/u;

/**
 * A path Windows could open through a remote host. Even `lstat` on such a path
 * can reach an SMB server and offer the caller's credentials, so this is decided
 * from the text alone. A mapped network drive looks like a local drive here.
 * POSIX hosts read repeated leading slashes as one local root.
 */
const namesNetworkShare = (path: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" &&
  HOST_PREFIXED_PATH.test(path) &&
  !LOCAL_DRIVE_DEVICE_PATH.test(path);

/**
 * `lstat` and `open` only. Without `realpath`, a rejected symlink's destination
 * is never resolved, so a link pointing at a UNC path cannot reach an SMB host.
 */
const LINK_BLIND_FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};

/** Where a Windows path's ancestors begin: past a drive root or device prefix. */
const WINDOWS_PATH_ROOT = /^(?:[\\/]{2}[?.][\\/])?(?:[A-Za-z]:)?[\\/]*/u;

/**
 * The first ancestor directory of a Windows path that is a symbolic link or
 * junction, walked from the root down. Each `lstat` reaches only directories
 * already checked, so a link to a UNC path is found before anything follows it.
 * An ancestor that cannot be read ends the walk and leaves the error to the reader.
 */
const linkedWindowsAncestor = async (
  path: string,
): Promise<string | undefined> => {
  const start = WINDOWS_PATH_ROOT.exec(path)?.[0].length ?? 0;
  for (let index = start; index < path.length; index += 1) {
    const separator = path[index];
    if (separator !== "\\" && separator !== "/") continue;
    const previous = path[index - 1];
    if (previous === "\\" || previous === "/") continue;
    const ancestor = path.slice(0, index);
    try {
      if ((await LINK_BLIND_FILE_SYSTEM.lstat(ancestor)).isSymbolicLink())
        return ancestor;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Portable Shell Link reader over one bounded, identity-checked regular file. */
export class WindowsShortcutProvider implements WindowsShortcutPort {
  readonly identity = WINDOWS_SHORTCUT_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        WINDOWS_SHORTCUT_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectWindowsShortcutInput,
    options?: ExecutionOptions,
  ) {
    if (namesNetworkShare(input.path, this.platform))
      return err(
        new AnalysisInputError(OPERATION, {}, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `Selected shortcut is on a network share, which this offline operation does not open: ${input.path}. Copy it to a local path first.`,
          },
        ]),
      );
    const linkedAncestor =
      this.platform === "win32"
        ? await linkedWindowsAncestor(input.path)
        : undefined;
    if (linkedAncestor !== undefined)
      return err(
        new AnalysisInputError(OPERATION, {}, [
          {
            path: ["path"],
            reason: "invalid_value",
            message: `Selected shortcut path passes through a directory link or junction, which this offline operation does not follow: ${linkedAncestor}. Select the shortcut by a path without links.`,
          },
        ]),
      );
    let completed: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          LINK_BLIND_FILE_SYSTEM,
          this.#resources,
        );
        completed = snapshot;
        assertArtifactReadActive(options?.signal);
        const report = await parseWindowsShortcut(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
          options?.signal,
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      const failure = windowsShortcutFailure(cause, input);
      if (completed !== undefined)
        failure.retainPartialObservation(
          fileSnapshotPartialObservationSchema.parse({
            kind: "file-snapshot-hash",
            path: input.path,
            sha256: completed.sha256,
            bytes: completed.bytes.length,
          }),
        );
      return err(failure);
    }
  }
}

const fileSizeRemediation = (input: InspectWindowsShortcutInput): string =>
  input.max_file_bytes >= MAX_INSPECT_WINDOWS_SHORTCUT_FILE_BYTES
    ? `The shortcut exceeds the ${String(MAX_INSPECT_WINDOWS_SHORTCUT_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const SELECTED_BUDGETS = {
  id_list_items: {
    argument: "max_id_list_items",
    maximum: MAX_INSPECT_WINDOWS_SHORTCUT_ID_LIST_ITEMS,
    unit: "entries",
  },
  extra_data_blocks: {
    argument: "max_extra_data_blocks",
    maximum: MAX_INSPECT_WINDOWS_SHORTCUT_EXTRA_DATA_BLOCKS,
    unit: "entries",
  },
  string_bytes: {
    argument: "max_string_bytes",
    maximum: MAX_INSPECT_WINDOWS_SHORTCUT_STRING_BYTES,
    unit: "bytes",
  },
} as const satisfies Record<
  WindowsShortcutSelectedBoundary,
  {
    readonly argument: keyof InspectWindowsShortcutInput;
    readonly maximum: number;
    readonly unit: string;
  }
>;

const budgetRemediation = (
  input: InspectWindowsShortcutInput,
  boundary: WindowsShortcutSelectedBoundary,
): string => {
  const { argument, maximum, unit } = SELECTED_BUDGETS[boundary];
  const selected = input[argument];
  const recovery =
    selected >= maximum
      ? `This release has no override above the ${String(maximum)} ${unit} ceiling; select a smaller shortcut.`
      : `Raise ${argument} on the next call, up to ${String(maximum)} ${unit}, or select a smaller shortcut; no restart is required.`;
  return `Effective ${argument} is ${String(selected)} ${unit}. ${recovery}`;
};

const windowsShortcutFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectWindowsShortcutInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof WindowsShortcutResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum },
      {
        cause,
        retryable: false,
        remediationAction: budgetRemediation(input, cause.boundary),
      },
    );
  if (cause instanceof WindowsShortcutFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${input.path}: ${cause.message}`,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: fileSizeRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected shortcut could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(WINDOWS_SHORTCUT_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const windowsShortcutFailure = (
  cause: unknown,
  input: InspectWindowsShortcutInput,
): AnalysisError => {
  const primary = windowsShortcutFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    WINDOWS_SHORTCUT_PROVIDER.id,
    OPERATION,
  );
};
