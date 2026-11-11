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
import type { Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";

/** A published tree whose output handles could not be released. */
export type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

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

/**
 * Write a new or empty folder through the safe output tree, rolling an
 * unpublished tree back on any failure so no partial copy remains. A
 * published tree is kept; a failed release of its handles is returned. A
 * refused destination names the caller's `field` under `operation`.
 */
export const writeOutputTree = async (
  plan: DesktopOutputPlan,
  write: (tree: SafeOutputTree) => Promise<void>,
  refusal: { readonly operation: string; readonly field: string },
  signal: AbortSignal | undefined,
): Promise<FailedRelease | undefined> => {
  signal?.throwIfAborted();
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
    if (released.kind === "failed") {
      if (tree.published) return released;
      throw resources.cleanupFailure(outcome, [released]);
    }
    if (tree.published) return undefined;
  }
  if (outcome.kind === "failed")
    throw outputDirectoryAdmissionRefusal(
      refusal.operation,
      refusal.field,
      outcome.cause,
    );
  return undefined;
};

/** A complete folder whose output handles could not be closed, reported with what it holds. */
export const writtenWithOpenHandles = (
  context: {
    readonly provider: string;
    readonly operation: string;
    readonly what: string;
  },
  directory: string,
  release: FailedRelease,
  evidence?: Evidence,
): ProviderAdapterError => {
  const reason =
    release.cause instanceof Error
      ? release.cause.message
      : String(release.cause);
  const error = new ProviderAdapterError(context.provider, context.operation, {
    userMessage: `The ${context.what} was written to ${directory} and is complete, but its output handles could not be closed: ${reason}.`,
    remediationAction: `Use the written ${context.what}; the handles are released when this process exits.`,
    cleanup: { reason, resources: [directory] },
    ...(evidence === undefined ? {} : { partialObservation: evidence }),
    diagnostics: { output_directory: directory },
  });
  release.lease.bindCleanupError(error);
  return error;
};
