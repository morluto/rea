import { createHash } from "node:crypto";

import {
  withOwnedRegularFile,
  RegularFileCancelled,
  RegularFileCleanupFailure,
} from "./OwnedRegularFile.js";
import {
  RegularFileChangedError,
  RegularFileOperationCancelled,
  assertRegularFileActive,
  assertStableRegularFileIdentity,
  regularFileState,
  type RegularFileState,
  type StableRegularFileDescriptor,
} from "./RegularFile.js";
import type { OwnedFileHandle } from "./OwnedFileHandle.js";

export interface StableFileHashOptions {
  readonly signal?: AbortSignal;
  readonly retainFailedClose: (owner: OwnedFileHandle) => void;
}

export interface StableFileObservation {
  readonly state: RegularFileState;
  readonly sha256: string;
  readonly bytes: number;
  /** The first two bytes, read from the same descriptor and stream as the hash. */
  readonly prefix: Buffer;
}

const STABLE_FILE_PREFIX_BYTES = 2;

interface StableFileFingerprint {
  readonly sha256: string;
  readonly bytes: number;
}

/** Physical hash admission/read failure with no outstanding descriptor cleanup. */
export class StableFileHashFailure extends Error {
  readonly _tag = "StableFileHashFailure";
  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(
      `Could not hash ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = this._tag;
  }
}

/** Read the producing boundary's physical failure without guessing from signal state. */
export const stableFileHashCause = (cause: unknown): unknown =>
  cause instanceof StableFileHashFailure ? cause.cause : cause;

/** Hash one regular file from its admitted descriptor and verify its path state. */
export const hashStableFile = async (
  path: string,
  options: StableFileHashOptions,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  return await readStableFile(path, options, false);
};

/** Hash a stable file and capture exactly its first two bytes from that read. */
export const observeStableFile = (
  path: string,
  options: StableFileHashOptions,
): Promise<StableFileObservation> => readStableFile(path, options, true);

function readStableFile(
  path: string,
  options: StableFileHashOptions,
  includePrefix: false,
): Promise<StableFileFingerprint>;
function readStableFile(
  path: string,
  options: StableFileHashOptions,
  includePrefix: true,
): Promise<StableFileObservation>;
async function readStableFile(
  path: string,
  options: StableFileHashOptions,
  includePrefix: boolean,
): Promise<StableFileFingerprint | StableFileObservation> {
  try {
    return await withOwnedRegularFile(path, options, async (source) => {
      const { prefix, ...fingerprint } = await hashStableRegularFileDescriptor(
        source,
        path,
        {
          symlinks: "follow",
          prefixBytes: includePrefix ? STABLE_FILE_PREFIX_BYTES : 0,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      return includePrefix
        ? { ...fingerprint, prefix, state: regularFileState(source.initial) }
        : fingerprint;
    });
  } catch (cause: unknown) {
    if (
      cause instanceof RegularFileCleanupFailure ||
      cause instanceof RegularFileCancelled ||
      cause instanceof RegularFileOperationCancelled
    )
      throw cause;
    throw new StableFileHashFailure(path, cause);
  }
}

/**
 * Hash an admitted descriptor from offset 0 to its admitted size, then verify
 * that `path` still names the same unchanged file. `symlinks` must match the
 * admission that opened the descriptor. The first `prefixBytes` bytes are
 * captured from the same read. A file that changes, grows or shrinks raises
 * `RegularFileChangedError`; an aborted signal raises
 * `RegularFileOperationCancelled`.
 */
export const hashStableRegularFileDescriptor = async (
  { handle, initial }: StableRegularFileDescriptor,
  path: string,
  options: {
    readonly symlinks: "follow" | "reject";
    readonly signal?: AbortSignal;
    readonly prefixBytes?: number;
  },
): Promise<StableFileFingerprint & { readonly prefix: Buffer }> => {
  if (!Number.isSafeInteger(initial.size) || initial.size < 0)
    throw new RangeError(
      `Regular file size cannot be represented safely: ${path}`,
    );
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const prefix = Buffer.alloc(Math.min(options.prefixBytes ?? 0, initial.size));
  let position = 0;
  while (position <= initial.size) {
    assertRegularFileActive(options.signal);
    const length = Math.min(chunk.length, initial.size - position + 1);
    if (length <= 0) break;
    const read = await handle.read(chunk, 0, length, position);
    if (
      position + read.bytesRead > initial.size ||
      (read.bytesRead === 0 && position < initial.size)
    )
      throw new RegularFileChangedError(path);
    assertRegularFileActive(options.signal);
    if (read.bytesRead === 0) break;
    if (position < prefix.length) {
      const prefixBytes = Math.min(read.bytesRead, prefix.length - position);
      chunk.copy(prefix, position, 0, prefixBytes);
    }
    hash.update(chunk.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  assertRegularFileActive(options.signal);
  if (position !== initial.size) throw new RegularFileChangedError(path);
  await assertStableRegularFileIdentity(handle, path, initial, {
    symlinks: options.symlinks,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { sha256: hash.digest("hex"), bytes: position, prefix };
};
