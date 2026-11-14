import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  outputDirectoryAdmissionRefusal,
  SafeOutputTreeDestinationRefusal,
} from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { canonicalCallerPath } from "../../filesystem/canonicalCallerPath.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import type { Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";

/** A published tree whose output handles could not be released. */
type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

/** Facts observed by the output owner after publication and final cleanup. */
export interface DesktopOutputCompletion {
  readonly kind: "published";
  readonly release: FailedRelease | undefined;
  readonly cancellation: AnalysisCancelledError | undefined;
}

/** A caller-selected destination and the filesystem path admitted for writing. */
export interface DesktopOutputPlan {
  readonly requested: string;
  readonly physical: string;
}

/** Establish destination identity before either output tree is created. */
export const planOutputTree = async (
  requested: string,
  refusal: { readonly operation: string; readonly field: string },
): Promise<DesktopOutputPlan> => {
  try {
    if (!isAbsolute(requested))
      throw new SafeOutputTreeDestinationRefusal(
        "Output root must be absolute",
      );
    if (basename(requested) === ".." || basename(requested) === ".")
      throw new SafeOutputTreeDestinationRefusal("Invalid output directory");
    const physical = await canonicalCallerPath(requested);
    const absolute = absoluteCallerPath(requested);
    const selected =
      absolute.length > 1 ? absolute.replace(/\/$/u, "") : absolute;
    const existing = await lstat(selected).then(
      (value) => value,
      (cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw cause;
      },
    );
    if (existing?.isSymbolicLink())
      throw new SafeOutputTreeDestinationRefusal(
        "Output root cannot be a symbolic link",
      );
    if (existing !== undefined && !existing.isDirectory())
      throw new SafeOutputTreeDestinationRefusal(
        "Output root must be a directory",
      );
    if (existing !== undefined && (await readdir(selected)).length > 0)
      throw new SafeOutputTreeDestinationRefusal(
        "Output directory is not empty",
      );
    return Object.freeze({ requested, physical });
  } catch (cause: unknown) {
    const error =
      cause instanceof SafeOutputTreeDestinationRefusal
        ? cause
        : new SafeOutputTreeDestinationRefusal(
            "Output destination cannot be resolved",
            { cause },
          );
    throw outputDirectoryAdmissionRefusal(
      refusal.operation,
      refusal.field,
      error,
    );
  }
};

/** Observe cancellation at an output-owned checkpoint without interpreting a caught cause. */
const outputCancellation = (
  operation: string,
  signal: AbortSignal | undefined,
) =>
  signal?.aborted === true
    ? new AnalysisCancelledError(operation, { cause: signal.reason })
    : undefined;

/**
 * Write a new or empty folder through the safe output tree, rolling an
 * unpublished tree back on any failure so no partial copy remains. A
 * published tree is kept; its cleanup and cancellation facts are returned. A
 * refused destination names the caller's `field` under `operation`.
 */
export const writeOutputTree = async (
  plan: DesktopOutputPlan,
  write: (tree: SafeOutputTree) => Promise<void>,
  refusal: { readonly operation: string; readonly field: string },
  signal: AbortSignal | undefined,
): Promise<DesktopOutputCompletion> => {
  const cancelled = outputCancellation(refusal.operation, signal);
  if (cancelled !== undefined) throw cancelled;
  await mkdir(dirname(plan.physical), { recursive: true, mode: 0o700 });
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let outcome:
    | { readonly kind: "completed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    try {
      tree = await SafeOutputTree.create(plan.physical, process.platform, {
        acceptExistingEmpty: true,
      });
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      throw cause;
    }
    await write(tree);
    await tree.commit(signal);
    outcome = { kind: "completed" };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (tree !== undefined) {
    const released = await resources.release({
      kind: "output-tree",
      resource: plan.requested,
      tree,
    });
    if (tree.published)
      return {
        kind: "published",
        release: released.kind === "failed" ? released : undefined,
        cancellation: outputCancellation(refusal.operation, signal),
      };
    if (released.kind === "failed")
      throw resources.cleanupFailure(outcome, [released]);
  }
  if (outcome.kind === "failed")
    throw outputDirectoryAdmissionRefusal(
      refusal.operation,
      refusal.field,
      outcome.cause,
    );
  throw new Error("Output tree completed without publication");
};

/** Project publication facts after the caller has its complete Evidence. */
export const desktopOutputFailure = (
  context: {
    readonly provider: string;
    readonly operation: string;
    readonly what: string;
  },
  directory: string,
  completion: DesktopOutputCompletion,
  evidence?: Evidence,
): AnalysisError | undefined => {
  const { release, cancellation } = completion;
  if (cancellation !== undefined && evidence !== undefined)
    cancellation.retainPartialObservation(evidence);
  if (release === undefined) return cancellation;
  const reason =
    release.cause instanceof Error
      ? release.cause.message
      : String(release.cause);
  const error = new ProviderAdapterError(context.provider, context.operation, {
    cause: release.cause,
    userMessage: `The ${context.what} was written to ${directory} and is complete, but its output handles could not be closed: ${reason}.`,
    remediationAction: `Use the written ${context.what}; the handles are released when this process exits.`,
    cleanup: { reason, resources: [directory] },
    ...(evidence === undefined ? {} : { partialObservation: evidence }),
    diagnostics: { output_directory: directory },
  });
  release.lease.bindCleanupError(error);
  return cancellation === undefined
    ? error
    : analysisErrorWithCancellation(error, cancellation);
};
