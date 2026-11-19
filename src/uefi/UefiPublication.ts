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
import type {
  UefiExtractResult,
  UefiOperation,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import { uefiFailure } from "./UefiFailures.js";

const UEFI_PROVIDER_ID = "rea-uefi";

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
        ...entry.facts,
        relative_path: written.relativePath,
        path: join(tree.outputRoot, written.relativePath),
        size: written.bytesWritten,
        sha256: written.sha256,
      });
    }
    result = context.buildResult(tree.outputRoot, files);
    context.checkpoint();
    await tree.commit(context.signal);
    return { result };
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
      if (tree.published && result !== undefined) return { result };
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
    if (tree.published && result !== undefined) return { result, failure };
    throw failure;
  }
};
