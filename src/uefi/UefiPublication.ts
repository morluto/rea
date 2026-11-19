import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../artifacts/SafeOutputTreeCreationFailure.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { uefiFailure } from "./UefiFailures.js";

const UEFI_PROVIDER_ID = "rea-uefi";

/** One extraction payload staged in memory; hashed before publication. */
export interface UefiPublicationEntry {
  readonly relativePath: string;
  readonly bytes: Buffer;
}

/** Published-file projection matching the uefi extract result schema. */
export interface UefiPublishedFile {
  readonly relative_path: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UefiPublicationOutcome {
  readonly outputRoot: string;
  readonly files: readonly UefiPublishedFile[];
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
  readonly signal?: AbortSignal;
}): Promise<UefiPublicationOutcome> => {
  let tree: SafeOutputTree | undefined;
  try {
    tree = await SafeOutputTree.create(context.outputDirectory).catch(
      (creationCause: unknown) =>
        creationCause instanceof SafeOutputTreeCreationFailure &&
        creationCause.tree !== undefined
          ? creationCause.tree
          : undefined,
    );
    if (tree === undefined) {
      throw new Error("SafeOutputTree creation produced no tree.");
    }
    const files: UefiPublishedFile[] = [];
    for (const entry of context.entries) {
      context.signal?.throwIfAborted();
      const sha256 = createHash("sha256").update(entry.bytes).digest("hex");
      await tree.write(
        entry.relativePath,
        Readable.from([entry.bytes]),
        { sha256, bytes: entry.bytes.length },
        context.signal,
      );
      files.push({
        relative_path: entry.relativePath,
        path: join(tree.outputRoot, entry.relativePath),
        size: entry.bytes.length,
        sha256,
      });
    }
    context.signal?.throwIfAborted();
    await tree.commit(context.signal);
    return { outputRoot: tree.outputRoot, files };
  } catch (cause: unknown) {
    let rollback: ProviderCleanupError | undefined;
    if (tree !== undefined) {
      try {
        await tree.rollback();
      } catch (rollbackCause: unknown) {
        rollback = new ProviderCleanupError(
          UEFI_PROVIDER_ID,
          ["output-tree"],
          {
            reason:
              rollbackCause instanceof Error
                ? rollbackCause.message
                : String(rollbackCause),
          },
          { operation: context.operation },
        );
      }
    }
    if (context.signal?.aborted) {
      const cancelled = new AnalysisCancelledError(context.operation);
      throw rollback === undefined
        ? cancelled
        : analysisErrorWithCleanupFailure(
            cancelled,
            rollback,
            context.operation,
          );
    }
    const primary = uefiFailure(
      cause,
      context.operation,
      context.outputDirectory,
    );
    throw rollback === undefined
      ? primary
      : analysisErrorWithCleanupFailure(primary, rollback, context.operation);
  }
};
