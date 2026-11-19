import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLeaseGroup } from "../artifacts/AnalysisCleanupLease.js";
import { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../artifacts/SafeOutputTreeCreationFailure.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
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
}): Promise<UefiPublicationOutcome> => {
  let tree: SafeOutputTree | undefined;
  const files: UefiPublishedFile[] = [];
  try {
    context.checkpoint();
    tree = await SafeOutputTree.create(context.outputDirectory);
    for (const entry of context.entries) {
      context.checkpoint();
      const sha256 = createHash("sha256").update(entry.bytes).digest("hex");
      const written = await tree.write(
        entry.relativePath,
        Readable.from([entry.bytes]),
        { sha256, bytes: entry.bytes.length },
        context.signal,
      );
      files.push({
        relative_path: written.relativePath,
        path: join(tree.outputRoot, written.relativePath),
        size: written.bytesWritten,
        sha256: written.sha256,
      });
    }
    context.checkpoint();
    await tree.commit(context.signal);
    return { outputRoot: tree.outputRoot, files };
  } catch (cause: unknown) {
    if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
    const primary = uefiFailure(
      cause,
      context.operation,
      context.outputDirectory,
    );
    if (tree === undefined) throw primary;

    const released = await context.resources.release({
      kind: "output-tree",
      resource: tree.outputRoot,
      tree,
    });
    if (released.kind === "released") {
      primary.resolveCleanup();
      if (tree.published) return { outputRoot: tree.outputRoot, files };
      throw primary;
    }
    const cleanup = new ProviderCleanupError(
      UEFI_PROVIDER_ID,
      [tree.outputRoot],
      { reason: String(released.cause) },
      { cause: released.cause, operation: context.operation },
    );
    new AnalysisCleanupLeaseGroup(cleanup, [released.lease]);
    // The exact tree owns pending publication handles and rollback together.
    if (primary.cleanupIncomplete)
      new AnalysisCleanupLeaseGroup(primary, [released.lease]);
    const failure = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      context.operation,
    ).bindCleanupDependencies([primary, cleanup]);
    if (tree.published) return { outputRoot: tree.outputRoot, files, failure };
    throw failure;
  }
};
