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
import { errorMessage } from "../kernel/errorMessage.js";

export interface StableFileHashOptions {
  readonly signal?: AbortSignal;
  readonly retainFailedClose: (owner: OwnedFileHandle) => void;
  /** Optional synchronous observer invoked with each read slice (reused buffer; copy if retained). */
  readonly onChunk?: (chunk: Buffer) => void;
}

export interface StableFileIdentity extends StableFileFingerprint {
  readonly state: RegularFileState;
}

export interface StableFileObservation extends StableFileIdentity {
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
    super(`Could not hash ${path}: ${errorMessage(cause)}`, { cause });
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
  return await readStableFile(path, options, "digest");
};

/** Hash a stable file and capture exactly its first two bytes from that read. */
export const observeStableFile = (
  path: string,
  options: StableFileHashOptions,
): Promise<StableFileObservation> => readStableFile(path, options, "prefix");

/** Hash and retain the identity of the same verified opened descriptor. */
export const observeStableFileIdentity = (
  path: string,
  options: StableFileHashOptions,
): Promise<StableFileIdentity> => readStableFile(path, options, "identity");

function readStableFile(
  path: string,
  options: StableFileHashOptions,
  mode: "digest",
): Promise<StableFileFingerprint>;
function readStableFile(
  path: string,
  options: StableFileHashOptions,
  mode: "prefix",
): Promise<StableFileObservation>;
function readStableFile(
  path: string,
  options: StableFileHashOptions,
  mode: "identity",
): Promise<StableFileIdentity>;
async function readStableFile(
  path: string,
  options: StableFileHashOptions,
  mode: "digest" | "identity" | "prefix",
): Promise<StableFileFingerprint | StableFileIdentity | StableFileObservation> {
  try {
    return await withOwnedRegularFile(path, options, async (source) => {
      const { prefix, ...fingerprint } = await hashStableRegularFileDescriptor(
        source,
        path,
        {
          symlinks: "follow",
          prefixBytes: mode === "prefix" ? STABLE_FILE_PREFIX_BYTES : 0,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onChunk === undefined
            ? {}
            : { onChunk: options.onChunk }),
        },
      );
      if (mode === "digest") return fingerprint;
      const identity = {
        ...fingerprint,
        state: regularFileState(source.initial),
      };
      return mode === "prefix" ? { ...identity, prefix } : identity;
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
    readonly onChunk?: (chunk: Buffer) => void;
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
    const slice = chunk.subarray(0, read.bytesRead);
    hash.update(slice);
    options.onChunk?.(slice);
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
