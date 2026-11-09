import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  resolvedRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import {
  artifactFileCompletion,
  artifactSelectedPathErrno,
  withArtifactFileHandle,
  assertArtifactReadActive,
} from "./ArtifactFileOperation.js";

/** Exact physical read completed before descriptor finalization. */
export interface StableArtifactSnapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Recover only the exact stable-read outcome retained by descriptor finalization. */
export const completedStableArtifact = (
  cause: unknown,
): StableArtifactSnapshot | undefined => {
  const value = artifactFileCompletion(cause)?.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("bytes" in value) ||
    !Buffer.isBuffer(value.bytes) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string"
  )
    return undefined;
  return { bytes: value.bytes, sha256: value.sha256 };
};

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
  realpath?(path: string): Promise<string>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
  realpath,
};

const afterValidation = async <T>(
  path: string,
  stage: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    if (artifactSelectedPathErrno(cause) !== undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed ${stage}: ${path}`,
        { cause },
      );
    throw cause;
  }
};

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<StableArtifactSnapshot> =>
  readStableArtifactChunks(
    path,
    maximumBytes,
    signal,
    fileSystem,
    resourceScope,
    (size) => size,
    undefined,
    (bytes, sha256) => ({ bytes, sha256 }),
  );

/** Whole-file identity of one streamed stable read and its retained prefix. */
export interface StableArtifactStream {
  readonly sha256: string;
  readonly size: number;
  /** The first `retainBytes(size)` bytes; the whole file when that equals size. */
  readonly prefix: Buffer;
}

/** Options for one streamed stable read. */
export interface StableArtifactStreamOptions {
  /** Bytes to retain from the start of the file, given its admitted size. */
  readonly retainBytes: (size: number) => number;
  /**
   * Observe every physical chunk in file order. The buffer may be reused after
   * the callback returns, so it must be consumed synchronously.
   */
  readonly onChunk: (chunk: Buffer) => void;
  readonly signal?: AbortSignal | undefined;
  readonly fileSystem?: StableArtifactFileSystem;
  readonly resourceScope?: ArtifactResourceScope | undefined;
}

/**
 * Stream one bounded regular file in fixed chunks with the same identity,
 * freshness, cancellation, and descriptor-ownership checks as
 * {@link readStableArtifact}, retaining only a caller-sized prefix.
 */
export const streamStableArtifact = (
  path: string,
  maximumBytes: number,
  options: StableArtifactStreamOptions,
): Promise<StableArtifactStream> =>
  readStableArtifactChunks(
    path,
    maximumBytes,
    options.signal,
    options.fileSystem ?? FILE_SYSTEM,
    options.resourceScope,
    options.retainBytes,
    options.onChunk,
    (prefix, sha256, size) => ({ sha256, size, prefix }),
  );

const readStableArtifactChunks = async <Value>(
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  fileSystem: StableArtifactFileSystem,
  resourceScope: ArtifactResourceScope | undefined,
  retainBytes: (size: number) => number,
  onChunk: ((chunk: Buffer) => void) | undefined,
  complete: (retained: Buffer, sha256: string, size: number) => Value,
): Promise<Value> => {
  assertArtifactReadActive(signal);
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
      before.isSymbolicLink()
        ? { resolvedPath: await resolvedRegularFile(path, fileSystem) }
        : {},
    );
  const maximumSize = BigInt(maximumBytes);
  if (before.size > maximumSize)
    throw new ArtifactReaderFailure(
      "limit",
      `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
      { boundary: "file-size" },
    );
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await file.stat({ bigint: true });
      if (
        !initial.isFile() ||
        initial.dev !== before.dev ||
        initial.ino !== before.ino
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Artifact changed before open: ${path}`,
        );
      assertArtifactReadActive(signal);
      // A raced descriptor size must not allocate beyond the selected budget.
      // These private bytes are published only after the exact count and both
      // file identities below validate, so an incomplete read exposes no tail.
      const admitted = Number(
        initial.size > maximumSize ? maximumSize : initial.size,
      );
      const bytes = Buffer.allocUnsafe(
        Math.max(0, Math.min(admitted, retainBytes(admitted))),
      );
      const overflow = Buffer.allocUnsafe(65536);
      const hash = createHash("sha256");
      let count = 0;
      for (;;) {
        assertArtifactReadActive(signal);
        const inside = count < bytes.length;
        const target = inside ? bytes : overflow;
        const offset = inside ? count : 0;
        const wanted = Math.min(65536, target.length - offset);
        const { bytesRead } = await file.read(target, offset, wanted, count);
        // EOF still passes through the original final metadata/cancellation
        // checks. A rejected physical read remains primary over cancellation.
        if (bytesRead === 0) break;
        assertArtifactReadActive(signal);
        if (
          !Number.isSafeInteger(bytesRead) ||
          bytesRead < 0 ||
          bytesRead > wanted
        )
          throw new ArtifactReaderFailure(
            "format",
            `Artifact descriptor returned an invalid byte count: ${path}`,
          );
        count += bytesRead;
        if (count > maximumBytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Selected artifact grew beyond its byte limit: ${path}`,
            { boundary: "file-size" },
          );
        // Read growth into bounded scratch space while preserving physical
        // read failures and byte-budget refusal ahead of final integrity checks.
        const chunk = target.subarray(offset, offset + bytesRead);
        hash.update(chunk);
        onChunk?.(chunk);
      }
      const after = await file.stat({ bigint: true });
      const current = await afterValidation(path, "during read", () =>
        fileSystem.lstat(path),
      );
      if (
        [after, current].some((stat) => !sameRegularFileState(initial, stat)) ||
        BigInt(count) !== initial.size
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Artifact changed during read: ${path}`,
        );
      assertArtifactReadActive(signal);
      return complete(bytes, hash.digest("hex"), count);
    },
  );
};
