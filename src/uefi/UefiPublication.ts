import { sha256Hex } from "../kernel/sha256Hex.js";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  type ArtifactResourceScope,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  SafeOutputTree,
  SafeOutputTreeCreationFailure,
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

export interface UefiWriteReceipt {
  readonly relativePath: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

type UefiPublishedFile = UefiExtractResult["files"][number];

/** One staged payload with provenance from the scanner that supplied it. */
export interface UefiPublicationEntry {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly facts?: Omit<
    UefiPublishedFile,
    "path" | "size" | "sha256" | "relative_path"
  >;
}

interface UefiPublicationOutcome<T = UefiExtractResult> {
  readonly result: T;
  readonly failure?: AnalysisError;
}

/**
 * Publish extraction payloads through the SafeOutputTree contract: absent
 * output directory, exclusive creation, digest-verified writes, commit or
 * rollback. No executable bits are ever set by the tree.
 */
export const publishUefiFiles = async <T = UefiExtractResult>(context: {
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
    receipts: readonly UefiWriteReceipt[],
  ) => T;
}): Promise<UefiPublicationOutcome<T>> => {
  let tree: SafeOutputTree | undefined;
  let result: T | undefined;
  const files: UefiPublishedFile[] = [];
  const receipts: UefiWriteReceipt[] = [];
  try {
    context.checkpoint();
    tree = await SafeOutputTree.create(context.outputDirectory);
    for (const entry of context.entries) {
      context.checkpoint();
      const sha256 = sha256Hex(entry.bytes);
      const written = await tree.write(
        entry.relativePath,
        Readable.from([entry.bytes]),
        { sha256, bytes: entry.bytes.length },
        context.signal,
      );
      receipts.push({
        relativePath: written.relativePath,
        path: join(tree.outputRoot, written.relativePath),
        size: written.bytesWritten,
        sha256: written.sha256,
      });
      if (entry.facts !== undefined) {
        files.push({
          ...entry.facts,
          relative_path: written.relativePath,
          path: join(tree.outputRoot, written.relativePath),
          size: written.bytesWritten,
          sha256: written.sha256,
        });
      }
    }
    result = context.buildResult(tree.outputRoot, files, receipts);
    context.checkpoint();
    await tree.commit(context.signal);
    return { result };
  } catch (cause: unknown) {
    if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
    const primary = classifyProviderFailure(
      cause,
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
