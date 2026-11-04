import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../../filesystem/readStableFileBytes.js";

/** Largest retained file the state view reads. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

/**
 * Reads retained content without following links and checks each digest.
 * A handle whose close failed is kept, with its path, for `release`.
 */
export class RetainedContent {
  readonly #unclosed: {
    readonly path: string;
    readonly owner: OwnedFileHandle;
  }[] = [];

  constructor(
    readonly folder: string,
    readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  /** The bytes stored under a digest, or undefined when missing or altered. */
  async read(
    sha256: string,
    signal?: AbortSignal,
  ): Promise<Buffer | undefined> {
    const path = join(this.folder, "content", sha256);
    const options = {
      symlinks: "reject" as const,
      retainFailedClose: (owner: OwnedFileHandle) => {
        this.#unclosed.push({ path, owner });
      },
      ...(signal === undefined ? {} : { signal }),
    };
    let bytes: Buffer;
    try {
      bytes = await withOwnedRegularFile(path, options, ({ handle }) =>
        readStableFileBytes(handle, path, this.maxBytes, options),
      );
    } catch (cause: unknown) {
      signal?.throwIfAborted();
      // A read that finished keeps its bytes; its failed close is retried by `release`.
      if (
        cause instanceof RegularFileCleanupFailure &&
        cause.outcome.kind === "completed" &&
        Buffer.isBuffer(cause.outcome.value)
      )
        bytes = cause.outcome.value;
      else if (cause instanceof Error) return undefined;
      else throw cause;
    }
    return createHash("sha256").update(bytes).digest("hex") === sha256
      ? bytes
      : undefined;
  }

  /** Close every kept handle; each close that fails again keeps its owner. */
  async release(resources: ArtifactResourceScope): Promise<FailedRelease[]> {
    const failures: FailedRelease[] = [];
    for (const { path, owner } of this.#unclosed.splice(0)) {
      const attempt = await resources.release({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
      if (attempt.kind === "failed") failures.push(attempt);
    }
    return failures;
  }
}

/**
 * Run with a retained content reader whose handles are released on every
 * exit. A release that fails is reported with the run's own outcome and the
 * exact handle owners.
 */
export const withRetainedContent = async <Value>(
  folder: string,
  run: (content: RetainedContent) => Promise<Value>,
  maxBytes?: number,
): Promise<Value> => {
  const content = new RetainedContent(folder, maxBytes);
  let outcome:
    | { readonly kind: "completed"; readonly value: Value }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    outcome = { kind: "completed", value: await run(content) };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const resources = new ArtifactResourceScope();
  const [first, ...rest] = await content.release(resources);
  if (first !== undefined)
    throw resources.cleanupFailure(outcome, [first, ...rest]);
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};
