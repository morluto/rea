import {
  ArtifactFileCleanupFailure,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
  readStableArtifact,
  zipArchiveFaultKind,
} from "../resources/index.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { BrowserExtensionPort } from "../ports/browserExtension/BrowserExtensionPort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  BROWSER_EXTENSION_BUDGETS,
  MAX_BROWSER_EXTENSION_ENTRIES,
  MAX_BROWSER_EXTENSION_FILE_BYTES,
  MAX_BROWSER_EXTENSION_MANIFEST_BYTES,
  type InspectBrowserExtensionInput,
} from "../domain/browserExtension/browserExtension.js";
import { err, ok } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { BROWSER_EXTENSION_PROVIDER } from "./BrowserExtensionProviderIdentity.js";
import {
  BrowserExtensionParseError,
  parseBrowserExtension,
} from "./parseBrowserExtension.js";

const OPERATION = "inspect_browser_extension";

/** Portable parser over one bounded, identity-checked regular file. */
export class BrowserExtensionProvider implements BrowserExtensionPort {
  readonly identity = BROWSER_EXTENSION_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        cause.cleanup === undefined
      )
        throw cause;
      const error = new ProviderCleanupError(
        BROWSER_EXTENSION_PROVIDER.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  async inspect(
    input: InspectBrowserExtensionInput,
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
          await parseBrowserExtension(
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
      return err(browserExtensionFailure(cause, input, options?.signal));
    }
  }
}

const budgetRemediation = (
  cause: BrowserExtensionParseError,
  input: InspectBrowserExtensionInput,
): string => {
  if (cause.limit === "fixed")
    return "This manifest field exceeds a fixed projection limit. Select a smaller manifest. Caller byte and entry budgets do not apply.";
  if (cause.limit === "max_entries")
    return input.max_entries >= MAX_BROWSER_EXTENSION_ENTRIES
      ? `The archive exceeds the ${String(MAX_BROWSER_EXTENSION_ENTRIES)}-entry ceiling this operation accepts.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller archive.`;
  if (cause.limit === "max_manifest_bytes")
    return input.max_manifest_bytes >= MAX_BROWSER_EXTENSION_MANIFEST_BYTES
      ? `manifest.json exceeds the ${String(MAX_BROWSER_EXTENSION_MANIFEST_BYTES)}-byte ceiling.`
      : `Raise max_manifest_bytes above ${String(input.max_manifest_bytes)} or select a smaller manifest.`;
  return input.max_file_bytes >= MAX_BROWSER_EXTENSION_FILE_BYTES
    ? `The package exceeds the ${String(MAX_BROWSER_EXTENSION_FILE_BYTES)}-byte ceiling.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} or select a smaller package.`;
};

/** The per-call control of an exhausted budget, while a larger value is selectable. */
const budgetLimit = (
  cause: BrowserExtensionParseError,
  input: InspectBrowserExtensionInput,
): { readonly limit?: AnalysisControlLimit } => {
  if (cause.limit === "fixed") return {};
  const parameter = cause.limit;
  const budget = BROWSER_EXTENSION_BUDGETS[parameter];
  const value = input[parameter];
  return value < budget.maximum
    ? {
        limit: {
          control_kind: "parameter",
          parameter,
          effective_value: value,
          unit: budget.unit,
          minimum: budget.minimum,
          maximum: budget.maximum,
          default_value: budget.default_value,
          applies_at: "next_call",
        },
      }
    : {};
};

const failurePrimary = (
  cause: unknown,
  input: InspectBrowserExtensionInput,
) => {
  if (cause instanceof BrowserExtensionParseError) {
    if (cause.code === "limit" && cause.resource !== null)
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.resource,
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_manifest_bytes: input.max_manifest_bytes,
          max_entries: input.max_entries,
          ...(cause.limits ?? {}),
        },
        {
          cause,
          retryable: false,
          remediationAction: budgetRemediation(cause, input),
          ...budgetLimit(cause, input),
        },
      );
    return new AnalysisInputError(
      OPERATION,
      { cause, userMessage: cause.message },
      [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ],
    );
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          ...(cause.boundary === undefined || cause.boundary === "memory"
            ? {}
            : {
                retryable: false,
                remediationAction:
                  input.max_file_bytes >= MAX_BROWSER_EXTENSION_FILE_BYTES
                    ? `The package exceeds the ${String(MAX_BROWSER_EXTENSION_FILE_BYTES)}-byte ceiling.`
                    : `Raise max_file_bytes above ${String(input.max_file_bytes)} or select a smaller package.`,
              }),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected extension package could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }
  if (cause instanceof DOMException && cause.name === "AbortError")
    return new AnalysisCancelledError(OPERATION, { cause });
  const zipFault = zipArchiveFaultKind(cause);
  if (zipFault !== undefined && cause instanceof Error)
    return new AnalysisInputError(
      OPERATION,
      { cause, userMessage: cause.message },
      [
        {
          path: ["path"],
          reason: "invalid_format",
          message:
            zipFault === "format"
              ? `ZIP archive is malformed: ${cause.message}`
              : `ZIP archive uses an unsupported feature: ${cause.message}`,
        },
      ],
    );
  return new ArtifactOperationError(
    OPERATION,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "Browser extension inspection failed.",
    { cause },
  );
};

const browserExtensionFailure = (
  cause: unknown,
  input: InspectBrowserExtensionInput,
  signal: AbortSignal | undefined,
) => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? failurePrimary(cause.fileCleanupFailure.outcome.cause, input)
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
        : failurePrimary(cause, input);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    BROWSER_EXTENSION_PROVIDER.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};
