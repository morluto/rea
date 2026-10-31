import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { fixedNativeAllowance } from "../../domain/native/nativeDeadlines.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { WindowsMinidumpPort } from "../../application/binaryDiagnostics/WindowsMinidumpPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_MINIDUMP_ENTRIES,
  MAX_INSPECT_MINIDUMP_FILE_BYTES,
  type InspectWindowsMinidumpInput,
} from "../../domain/native/windowsMinidump.js";
import { err, ok } from "../../domain/result.js";
import { WINDOWS_MINIDUMP_PROVIDER } from "../../domain/investigationProviders.js";
import {
  MAX_TOTAL_NAME_BYTES,
  parseWindowsMinidump,
} from "./WindowsMinidumpParser.js";

const OPERATION = "inspect_windows_minidump";

/** Portable parser over one bounded, identity-checked recorded dump file. */
export class WindowsMinidumpProvider implements WindowsMinidumpPort {
  readonly identity = WINDOWS_MINIDUMP_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        WINDOWS_MINIDUMP_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectWindowsMinidumpInput,
    options?: ExecutionOptions,
  ) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          await parseWindowsMinidump(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
            options?.signal,
          ),
        );
      });
    } catch (cause) {
      return err(minidumpFailure(cause, input));
    }
  }
}

/** Remediation for a caller-selected budget refusal, naming the ceiling when no raise is left. */
export const minidumpBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectWindowsMinidumpInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_MINIDUMP_FILE_BYTES
      ? `The dump exceeds the ${String(MAX_INSPECT_MINIDUMP_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_entries >= MAX_INSPECT_MINIDUMP_ENTRIES
      ? `The dump exceeds the ${String(MAX_INSPECT_MINIDUMP_ENTRIES)}-descriptor ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected descriptor budget.`;

const minidumpFailurePrimary = (
  { cause, origin }: ArtifactFilePrimaryFacts,
  input: InspectWindowsMinidumpInput,
) => {
  const classified =
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure;
  if (classified && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (classified && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (classified && cause.reason === "limit") {
    const metadata = cause.boundary === "memory";
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.boundary ?? "memory",
      cause.message,
      {
        max_file_bytes: input.max_file_bytes,
        max_entries: input.max_entries,
        ...(metadata ? { maximum_name_bytes: MAX_TOTAL_NAME_BYTES } : {}),
      },
      {
        cause,
        ...(cause.boundary === undefined
          ? {}
          : metadata
            ? fixedNativeAllowance(
                "The recorded module-name decoding allowance",
                "parser",
                `${String(MAX_TOTAL_NAME_BYTES)} bytes (16 MiB)`,
              )
            : {
                retryable: false as const,
                remediationAction: minidumpBudgetRemediation(
                  cause.boundary,
                  input,
                ),
              }),
      },
    );
  }
  if (classified && (cause.reason === "path" || cause.reason === "format"))
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: "invalid_format", message: cause.message },
    ]);
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
          message: `Selected minidump could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    OPERATION,
    classified ? cause.reason : "io",
    undefined,
    cause instanceof Error ? cause.message : "Minidump inspection failed.",
    { cause },
  );
};

const minidumpFailure = (cause: unknown, input: InspectWindowsMinidumpInput) =>
  projectStableArtifactFailure(
    cause,
    minidumpFailurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    WINDOWS_MINIDUMP_PROVIDER.id,
    OPERATION,
  );
