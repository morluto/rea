import { join } from "node:path";
import { Readable } from "node:stream";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  type ArtifactResourceScope,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  SafeOutputTree,
  SafeOutputTreeCreationFailure,
  outputDirectoryAdmissionRefusal,
} from "../resources/index.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type {
  UefiExtractResult,
  UefiOperation,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import { uefiFailureDialect } from "./UefiFailures.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";

import { UEFI_PROVIDER_IDENTITY } from "./UefiProviderIdentity.js";

type UefiPublishedFile = UefiExtractResult["files"][number];

/** One staged payload with provenance from the scanner that supplied it. */
export interface UefiPublicationEntry {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly facts: Omit<
    UefiPublishedFile,
    "path" | "size" | "sha256" | "relative_path"
  >;
}

interface UefiPublicationOutcome {
  readonly result: UefiExtractResult;
  readonly failure?: AnalysisError;
}

/**
 * Publish extraction payloads through the SafeOutputTree contract: absent
 * output directory, exclusive creation, digest-verified writes, commit or
 * rollback. No executable bits are ever set by the tree.
 */
export const publishUefiFiles = async (context: {
  readonly outputDirectory: string;
  readonly operation: UefiOperation;
  readonly entries: readonly UefiPublicationEntry[];
  readonly signal: AbortSignal;
  readonly checkpoint: () => void;
  readonly resources: ArtifactResourceScope;
  /** Validate the result with actual write receipts before committing the tree. */
  readonly buildResult: (
    outputRoot: string,
    files: UefiPublishedFile[],
  ) => UefiExtractResult;
}): Promise<UefiPublicationOutcome> => {
  let tree: SafeOutputTree | undefined;
  let result: UefiExtractResult | undefined;
  const files: UefiPublishedFile[] = [];
  try {
    context.checkpoint();
    tree = await SafeOutputTree.create(context.outputDirectory);
    const activeTree = tree;
    const slots = new Array<UefiPublishedFile | undefined>(
      context.entries.length,
    );
    let cursor = 0;
    let firstFailure: unknown;
    const publishWorker = async (): Promise<void> => {
      while (firstFailure === undefined) {
        const index = cursor++;
        const entry = context.entries[index];
        if (entry === undefined) return;
        try {
          context.checkpoint();
          const written = await activeTree.write(
            entry.relativePath,
            Readable.from([entry.bytes]),
            { bytes: entry.bytes.length },
            context.signal,
          );
          slots[index] = {
            ...entry.facts,
            relative_path: written.relativePath,
            path: join(activeTree.outputRoot, written.relativePath),
            size: written.bytesWritten,
            sha256: written.sha256,
          };
        } catch (cause: unknown) {
          firstFailure ??= cause;
          return;
        }
      }
    };
    const workerCount = Math.min(8, context.entries.length);
    await Promise.allSettled(
      Array.from({ length: workerCount }, () => publishWorker()),
    );
    if (firstFailure !== undefined) throw firstFailure;
    for (const item of slots) {
      if (item !== undefined) files.push(item);
    }
    result = context.buildResult(tree.outputRoot, files);
    context.checkpoint();
    await tree.commit(context.signal);
    return { result };
  } catch (cause: unknown) {
    if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
    // A refused destination is the caller's output_directory, not the image path.
    const primary = classifyProviderFailure(
      outputDirectoryAdmissionRefusal(
        context.operation,
        "output_directory",
        cause,
      ),
      uefiFailureDialect(context.operation, context.outputDirectory),
    );
    if (tree === undefined) throw primary;

    const ownedTree = tree;
    const lease = new AnalysisCleanupLease(async () => {
      await ownedTree.rollback();
    }, [ownedTree.outputRoot]);
    if (primary.cleanupIncomplete) lease.bindCleanupError(primary);
    const released = await context.resources.release({
      kind: "lease",
      resource: ownedTree.outputRoot,
      lease,
    });
    if (released.kind === "released") {
      if (tree.published && result !== undefined) return { result };
      throw primary;
    }
    const cleanup = new ProviderCleanupError(
      UEFI_PROVIDER_IDENTITY.id,
      [tree.outputRoot],
      { reason: String(released.cause) },
      { cause: released.cause, operation: context.operation },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [released.lease]);
    const failure = analysisErrorWithCleanupDependencies(
      primary,
      cleanup,
      context.operation,
    );
    if (tree.published && result !== undefined) return { result, failure };
    throw failure;
  }
};
