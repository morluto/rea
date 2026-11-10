import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { outputDirectoryAdmissionRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import type { Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";

/** A published tree whose output handles could not be released. */
export type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

/**
 * Write a new or empty folder through the safe output tree, rolling an
 * unpublished tree back on any failure so no partial copy remains. A
 * published tree is kept; a failed release of its handles is returned. A
 * refused destination names the caller's `field` under `operation`.
 */
export const writeOutputTree = async (
  directory: string,
  write: (tree: SafeOutputTree) => Promise<void>,
  refusal: { readonly operation: string; readonly field: string },
  signal: AbortSignal | undefined,
): Promise<FailedRelease | undefined> => {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let outcome:
    | { readonly kind: "completed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    try {
      tree = await SafeOutputTree.create(directory, process.platform, {
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
      resource: directory,
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
