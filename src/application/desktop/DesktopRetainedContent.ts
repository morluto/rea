import { createHash } from "node:crypto";
import { join } from "node:path";

import type { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../../filesystem/readStableFileBytes.js";

const MAX_VIEW_BYTES = 64 * 1024 * 1024;

/**
 * Reads retained content without following links, checks each digest, and
 * keeps handles whose close failed so `close` can retry them.
 */
export class RetainedContent {
  readonly #unclosed: OwnedFileHandle[] = [];

  constructor(readonly folder: string) {}

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
        readStableFileBytes(handle, path, MAX_VIEW_BYTES, options),
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
