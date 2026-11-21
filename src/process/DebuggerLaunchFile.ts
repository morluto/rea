import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { cancelledBy, carriedReason } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  unknownTarget,
  type FileTargetIdentity,
  type UnknownTargetIdentity,
} from "../domain/targetIdentity.js";
import {
  RegularFileCleanupFailure,
  RegularFileCancelled,
  regularFileCancellation,
} from "../filesystem/OwnedRegularFile.js";
import {
  hashStableFile,
  stableFileHashCause,
} from "../filesystem/StableFileHash.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  AnalysisCleanupLease,
  bindArtifactFileCleanup,
  type ArtifactResourceScope,
} from "../resources/index.js";

/** Initial file identity; later debugger commands do not rebind it. */
export interface DebuggerLaunchFileObservation {
  readonly identity: FileTargetIdentity | UnknownTargetIdentity;
  readonly unobservedReason?: string;
}

interface DebuggerStartupFileContext {
  readonly provider: string;
  readonly operation: string;
  readonly resources: ArtifactResourceScope;
}

/** Retry the exact failed file owners before admitting another startup. */
export const retryDebuggerStartupFileCleanup = async ({
  provider,
  operation,
  resources,
}: DebuggerStartupFileContext): Promise<Result<null, AnalysisError>> => {
  try {
    await resources.retryCleanup();
    return ok(null);
  } catch (cause: unknown) {
    const failure = new ProviderCleanupError(
      provider,
      resources.cleanupResources,
      {},
      { operation, cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return err(failure);
  }
};

/**
 * Observe the selected file once before loading it. Physical hash failures
 * preserve unknown identity and their reason. Cancellation and outstanding
 * descriptor cleanup fail startup; the caller's scope retains failed closes.
 */
export const observeDebuggerLaunchFile = async (
  path: string,
  {
    provider,
    operation,
    resources,
    signal,
  }: DebuggerStartupFileContext & {
    readonly signal?: AbortSignal | undefined;
  },
): Promise<Result<DebuggerLaunchFileObservation, AnalysisError>> => {
  let lease: AnalysisCleanupLease | undefined;
  try {
    const { sha256 } = await hashStableFile(path, {
      ...(signal === undefined ? {} : { signal }),
      retainFailedClose: (owner) => {
        lease = new AnalysisCleanupLease(() => owner.close(), [path]);
        resources.retain({ kind: "lease", resource: path, lease });
      },
    });
    return ok({
      identity: {
        kind: "file",
        sha256,
        format: "file",
        architecture: null,
        selection: null,
      },
    });
  } catch (cause: unknown) {
    const outcome =
      cause instanceof RegularFileCancelled ||
      cause instanceof RegularFileCleanupFailure
        ? cause.outcome
        : undefined;
    const completed =
      outcome?.kind === "completed"
        ? { completed_hash: jsonValueSchema.parse(outcome.value) }
        : undefined;
    const cancellation = regularFileCancellation(cause);
    const cancelled =
      cancellation === undefined
        ? undefined
        : cancelledBy(operation, carriedReason(cancellation.reason), {
            diagnostics: completed,
          });
    const describe = (failure: unknown): string =>
      errorMessage(stableFileHashCause(failure));
    if (!(cause instanceof RegularFileCleanupFailure)) {
      if (cancelled !== undefined) return err(cancelled);
      return ok({
        identity: unknownTarget("not-observed"),
        unobservedReason: describe(cause),
      });
    }
    const cleanup = new ProviderCleanupError(
      provider,
      [path],
      {
        ...completed,
        ...(cause.outcome.kind === "failed" && cancelled === undefined
          ? { launch_file_hash_failure: describe(cause.outcome.cause) }
          : {}),
      },
      { operation, cause: cause.cleanupCause },
    );
    const failure =
      cancelled === undefined
        ? cleanup
        : analysisErrorWithCleanupFailure(cancelled, cleanup, operation);
    lease?.bindCleanupError(cleanup);
    if (failure !== cleanup) lease?.bindCleanupError(failure);
    return err(failure);
  }
};
