import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DesktopApplicationCapture } from "../domain/desktop/desktopCapture.js";
import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../filesystem/readStableFileBytes.js";

type Omission = DesktopApplicationCapture["state"]["omitted_content"][number];

/** A stored file, or why its bytes were left out. */
export type RetainOutcome =
  | {
      readonly kind: "retained";
      readonly sha256: string;
      readonly size: number;
    }
  | { readonly kind: "omitted"; readonly reason: Omission["reason"] };

class ChangedSinceWalk extends Error {}

const UNREADABLE_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ELOOP",
  "ENXIO",
]);

/** Content-addressed copies of observed files under `<capture>/content`. */
export class DesktopContentStore {
  readonly #directory: string;
  readonly #maxFileBytes: number;
  readonly #stored = new Map<string, number>();
  readonly #omissions: Omission[] = [];
  #remainingBytes: number;

  constructor(
    captureDirectory: string,
    maxFileBytes: number,
    maxBytes: number,
  ) {
    this.#directory = join(captureDirectory, "content");
    this.#maxFileBytes = maxFileBytes;
    this.#remainingBytes = maxBytes;
  }

  /** Create the private content directory; it must not exist yet. */
  async prepare(): Promise<void> {
    await mkdir(this.#directory, { mode: 0o700 });
  }

  get files(): number {
    return this.#stored.size;
  }

  get bytes(): number {
    return [...this.#stored.values()].reduce((sum, size) => sum + size, 0);
  }

  get omissions(): readonly Omission[] {
    return this.#omissions;
  }

  /**
   * Copy one regular file if it is still the version the walk recorded and it
   * holds still while read. Content already stored costs no budget.
   */
  async retain(
    path: string,
    expected: DesktopPathState,
    signal?: AbortSignal,
  ): Promise<RetainOutcome> {
    const read = await this.#read(path, expected, signal);
    if (read.kind === "omitted") {
      this.#omissions.push({ path, reason: read.reason });
      return read;
    }
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const size = read.bytes.byteLength;
    if (this.#stored.has(sha256)) return { kind: "retained", sha256, size };
    if (size > this.#remainingBytes) {
      this.#omissions.push({ path, reason: "budget_exhausted" });
      return { kind: "omitted", reason: "budget_exhausted" };
    }
    const target = join(this.#directory, sha256);
    const partial = `${target}.partial`;
    await writeFile(partial, read.bytes, { mode: 0o600, flag: "wx" });
    await rename(partial, target);
    this.#stored.set(sha256, size);
    this.#remainingBytes -= size;
    return { kind: "retained", sha256, size };
  }

  async #read(
    path: string,
    expected: DesktopPathState,
    signal: AbortSignal | undefined,
  ): Promise<
    | { readonly kind: "read"; readonly bytes: Buffer }
    | Extract<RetainOutcome, { kind: "omitted" }>
  > {
    if (expected.type !== "file")
      return { kind: "omitted", reason: "unreadable" };
    if (expected.size > this.#maxFileBytes)
      return { kind: "omitted", reason: "too_large" };
    const options = {
      symlinks: "reject" as const,
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      const bytes = await withOwnedRegularFile(
        path,
        options,
        async ({ handle }) => {
          const stats = await handle.stat({ bigint: true });
          if (
            Number(stats.size) !== expected.size ||
            stats.mtimeNs.toString() !== expected.mtime_ns ||
            `${stats.dev.toString()}:${stats.ino.toString()}` !== expected.inode
          )
            throw new ChangedSinceWalk();
          return readStableFileBytes(handle, path, this.#maxFileBytes, options);
        },
      );
      return { kind: "read", bytes };
    } catch (cause: unknown) {
      signal?.throwIfAborted();
      if (cause instanceof ChangedSinceWalk)
        return { kind: "omitted", reason: "changed_since_walk" };
      if (cause instanceof RegularFileChangedError)
        return { kind: "omitted", reason: "changed_during_read" };
      if (cause instanceof RegularFileCapacityError)
        return { kind: "omitted", reason: "too_large" };
      if (
        cause instanceof NonRegularFileReadError ||
        UNREADABLE_CODES.has((cause as NodeJS.ErrnoException).code ?? "")
      )
        return { kind: "omitted", reason: "unreadable" };
      throw cause;
    }
  }
}
