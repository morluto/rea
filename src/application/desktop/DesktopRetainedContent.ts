import { createHash } from "node:crypto";
import { join } from "node:path";

import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../../filesystem/readStableFileBytes.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { DESKTOP_PROVIDER } from "./DesktopCaptureRefusals.js";

/** Largest retained file the state view reads. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads retained content without following links, checks each digest, and
 * keeps handles whose close failed so `close` can retry them.
 */
export class RetainedContent {
  readonly #unclosed: OwnedFileHandle[] = [];

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
        this.#unclosed.push(owner);
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
      // A failed close keeps its owner above; any read failure means no verified bytes.
      if (cause instanceof RegularFileCleanupFailure || cause instanceof Error)
        return undefined;
      throw cause;
    }
    return createHash("sha256").update(bytes).digest("hex") === sha256
      ? bytes
      : undefined;
  }

  /** Retry every failed close; rejects while one still fails. */
  async close(): Promise<void> {
    while (this.#unclosed.length > 0) {
      await this.#unclosed[0]?.close();
      this.#unclosed.shift();
    }
  }
}

/**
 * Run with a retained content reader that is closed on every exit. A close
 * that still fails after a retry is reported with the primary failure, if
 * there was one, and names the capture folder as the unresolved resource.
 */
export const withRetainedContent = async <Value>(
  folder: string,
  operation: string,
  run: (content: RetainedContent) => Promise<Value>,
  maxBytes?: number,
): Promise<Value> => {
  const content = new RetainedContent(folder, maxBytes);
  let outcome:
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly cause: unknown };
  try {
    outcome = { ok: true, value: await run(content) };
  } catch (cause: unknown) {
    outcome = { ok: false, cause };
  }
  try {
    await content.close();
  } catch (cause: unknown) {
    throw new ProviderAdapterError(DESKTOP_PROVIDER.id, operation, {
      cause: outcome.ok
        ? cause
        : new AggregateError(
            [outcome.cause, cause],
            "Reading retained content failed and a handle could not be closed.",
          ),
      userMessage: "A retained file REA read could not be closed.",
      cleanup: {
        reason: "a retained file's handle could not be closed after a retry",
        resources: [folder],
      },
    });
  }
  if (!outcome.ok) throw outcome.cause;
  return outcome.value;
};
