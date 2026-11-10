import { createHash } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { DesktopApplicationCapture } from "../domain/desktop/desktopCapture.js";
import type { DesktopPathState } from "../domain/desktop/desktopStateDiff.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  isSelectedRegularFileError,
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

/** Permission refusals; path changes use the shared selected-file classification. */
const DENIED_CODES = new Set(["EACCES", "EPERM", "ENXIO"]);

/** Content-addressed copies of observed files under `<capture>/content`. */
export class DesktopContentStore {
  readonly #directory: string;
  readonly #maxFileBytes: number;
  readonly #stored = new Map<string, number>();
  readonly #storedSizes = new Set<number>();
  readonly #omissions: Omission[] = [];
  /** Handles whose close failed; kept owned so `close` can retry them. */
  readonly #unclosed = new ArtifactResourceScope();
  /** The partial file being written, removed by `discard` if it was left. */
  #writing: string | undefined;
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

  /** Where retained content is stored. */
  get directory(): string {
    return this.#directory;
  }

  /**
   * Retry every handle whose close failed during a read. A handle that fails
   * again stays owned, and the rejection carries its exact cleanup lease.
   */
  close(): Promise<void> {
    return this.#unclosed.retryCleanup();
  }

  /**
   * Remove every file this store wrote, then its content directory. Rejects
   * when the directory holds anything else or a removal fails.
   */
  async discard(): Promise<void> {
    if (this.#writing !== undefined) await rm(this.#writing, { force: true });
    this.#writing = undefined;
    for (const sha256 of this.#stored.keys()) {
      await rm(join(this.#directory, sha256), { force: true });
      this.#stored.delete(sha256);
    }
    this.#storedSizes.clear();
    await rmdir(this.#directory).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    });
  }

  /**
   * Copy one regular file if it is still the version the walk recorded and it
   * holds still while read. Content already stored costs no budget; a file
   * larger than the remaining budget is read only when stored content of the
   * same size could make it a duplicate.
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
    const stored = await this.retainBytes(read.bytes);
    if (stored.kind === "omitted")
      this.#omissions.push({ path, reason: stored.reason });
    return stored;
  }

  /** Store bytes already read, such as a verified apt key; over the per-file limit or the remaining budget they are omitted. */
  async retainBytes(bytes: Buffer): Promise<RetainOutcome> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const size = bytes.byteLength;
    if (size > this.#maxFileBytes)
      return { kind: "omitted", reason: "too_large" };
    if (this.#stored.has(sha256)) return { kind: "retained", sha256, size };
    if (size > this.#remainingBytes)
      return { kind: "omitted", reason: "budget_exhausted" };
    const target = join(this.#directory, sha256);
    const partial = `${target}.partial`;
    this.#writing = partial;
    await writeFile(partial, bytes, { mode: 0o600, flag: "wx" });
    await rename(partial, target);
    this.#writing = undefined;
    this.#stored.set(sha256, size);
    this.#storedSizes.add(size);
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
    // Over budget, only a size some stored content has can still be a duplicate.
    if (
      expected.size > this.#remainingBytes &&
      !this.#storedSizes.has(expected.size)
    )
      return { kind: "omitted", reason: "budget_exhausted" };
    const options = {
      symlinks: "reject" as const,
      retainFailedClose: (handle: OwnedFileHandle) => {
        this.#unclosed.retain({ kind: "file-handle", resource: path, handle });
      },
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
      // The read finished or failed but its close did not; the owner is kept.
      if (cause instanceof RegularFileCleanupFailure)
        return { kind: "omitted", reason: "unreadable" };
      if (cause instanceof RegularFileChangedError)
        return { kind: "omitted", reason: "changed_during_read" };
      // The path was renamed, removed or retyped after the walk.
      if (isSelectedRegularFileError(cause))
        return { kind: "omitted", reason: "changed_since_walk" };
      if (cause instanceof RegularFileCapacityError)
        return { kind: "omitted", reason: "too_large" };
      if (
        cause instanceof NonRegularFileReadError ||
        DENIED_CODES.has((cause as NodeJS.ErrnoException).code ?? "")
      )
        return { kind: "omitted", reason: "unreadable" };
      throw cause;
    }
  }
}
