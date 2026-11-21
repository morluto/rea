import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { SafeOutputTree } from "./SafeOutputTree.js";

/**
 * `SafeOutputTree.create` refused the caller's selected destination itself:
 * a relative or reserved root, an existing root, or an accepted existing root
 * that is not an empty directory, or an unavailable parent observed during
 * destination admission.
 * Setup failures after a tree is acquired are not refusals of the selection.
 */
export class SafeOutputTreeDestinationRefusal extends ArtifactReaderFailure {
  #tree: SafeOutputTree | undefined;

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super("path", message, options);
    this.name = "SafeOutputTreeDestinationRefusal";
  }

  /**
   * The constructed tree for an accepted directory that was then refused.
   * The caller still owns the directory. Rollback preserves its root.
   */
  get retainedTree(): SafeOutputTree | undefined {
    return this.#tree;
  }

  retainTree(tree: SafeOutputTree): void {
    this.#tree = tree;
  }
}

/**
 * Attribute a destination refusal to the caller's selected directory argument.
 * `create` rethrows a refusal of an accepted existing root directly, because
 * the caller still owns that directory. That refusal can carry the
 * constructed tree so a writer can retry verification without removing the
 * caller's files. A wrapped `SafeOutputTreeCreationFailure` is still
 * recognized. Every other failure, including acquired-tree setup failures,
 * keeps its artifact semantics.
 */
export const outputDirectoryAdmissionRefusal = (
  operation: string,
  field: string,
  cause: unknown,
): unknown => {
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup !== undefined)
    return cause;
  const refusal =
    cause instanceof SafeOutputTreeDestinationRefusal
      ? cause
      : cause.cause instanceof SafeOutputTreeDestinationRefusal
        ? cause.cause
        : undefined;
  return refusal === undefined
    ? cause
    : new AnalysisInputError(
        operation,
        { cause, userMessage: refusal.message },
        [{ path: [field], reason: "invalid_value", message: refusal.message }],
      );
};
