import { invariantViolation } from "../domain/internalInvariant.js";
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

/** Positioned reads over the admitted descriptor of one stable file. */
export interface StableArtifactRangeSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
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

/** Recover only the exact streamed outcome retained by descriptor finalization. */
export const completedStableArtifactStream = (
  cause: unknown,
): StableArtifactStream | undefined => {
  const value = artifactFileCompletion(cause)?.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !("prefix" in value) ||
    !Buffer.isBuffer(value.prefix)
  )
    return undefined;
  return { sha256: value.sha256, size: value.size, prefix: value.prefix };
};

/** Whole-file identity of a completed buffered or streamed stable read. */
export const completedStableArtifactIdentity = (
  cause: unknown,
): { readonly sha256: string; readonly bytes: number } | undefined => {
  const snapshot = completedStableArtifact(cause);
  if (snapshot !== undefined)
    return { sha256: snapshot.sha256, bytes: snapshot.bytes.length };
  // A stream retains only a prefix; its size is the whole-file length.
  const stream = completedStableArtifactStream(cause);
  return stream === undefined
    ? undefined
    : { sha256: stream.sha256, bytes: stream.size };
};

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
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
        { cause, integrityCheck: "container-identity" },
      );
    throw cause;
  }
};

const DEFAULT_STREAM_CHUNK_BYTES = 65536;
const SNAPSHOT_READ_CHUNK_BYTES = 1048576;
const EOF_PROBE_BYTES = 4096;

/** Admit one regular file without following a symlink and open it read-only. */
const openRegularFile = async (
  path: string,
  fileSystem: StableArtifactFileSystem,
  admit: (before: BigIntStats) => void,
) => {
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
      before.isSymbolicLink()
        ? { resolvedPath: await resolvedRegularFile(path, fileSystem) }
        : {},
    );
  admit(before);
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  return { before, file };
};

/** Reject a descriptor whose file no longer matches the path admitted before open. */
const assertOpenedAdmitted = async (
  path: string,
  file: FileHandle,
  before: BigIntStats,
) => {
  const initial = await file.stat({ bigint: true });
  if (
    !initial.isFile() ||
    initial.dev !== before.dev ||
    initial.ino !== before.ino
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact changed before open: ${path}`,
      { integrityCheck: "container-identity" },
    );
  return initial;
};

/** Reject replacement or in-place change after `count` bytes were streamed. */
const assertUnchangedAfterRead = async (
  path: string,
  file: FileHandle,
  fileSystem: StableArtifactFileSystem,
  initial: BigIntStats,
  count: number,
) => {
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
      { integrityCheck: "container-identity" },
    );
};

/**
 * Read one bounded regular file and reject replacement or in-place changes.
 * The optional observer receives verified state before descriptor finalization;
 * callers may reuse it only after this promise resolves successfully.
 */
export const readStableArtifact = (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
  onValidatedState?: (state: BigIntStats) => void,
): Promise<StableArtifactSnapshot> =>
  readStableArtifactChunks({
    path,
    maximumBytes,
    chunkBytes: SNAPSHOT_READ_CHUNK_BYTES,
    signal,
    fileSystem,
    resourceScope,
    retainBytes: (size) => size,
    onChunk: undefined,
    complete: (bytes, sha256, _size, state) => {
      onValidatedState?.(state);
      return { bytes, sha256 };
    },
  });

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
   * the callback settles, so callers must consume or copy it before resolving.
   */
  readonly onChunk: (chunk: Buffer) => void | Promise<void>;
  /** Maximum read chunk size in bytes; defaults to 65536. */
  readonly chunkBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fileSystem?: StableArtifactFileSystem;
  readonly resourceScope?: ArtifactResourceScope | undefined;
}

/**
 * Stream one bounded regular file in fixed chunks with the same identity,
 * freshness, cancellation, and descriptor-ownership checks as
 * {@link readStableArtifact}, retaining only a caller-sized prefix.
 */
export const streamStableArtifact = async (
  path: string,
  maximumBytes: number,
  options: StableArtifactStreamOptions,
): Promise<StableArtifactStream> => {
  const chunkBytes = options.chunkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)
    throw new ArtifactReaderFailure(
      "format",
      `Artifact read chunk size must be a positive integer: ${String(chunkBytes)}`,
    );
  return readStableArtifactChunks({
    path,
    maximumBytes,
    chunkBytes,
    signal: options.signal,
    fileSystem: options.fileSystem ?? FILE_SYSTEM,
    resourceScope: options.resourceScope,
    retainBytes: options.retainBytes,
    onChunk: options.onChunk,
    complete: (prefix, sha256, size) => ({ sha256, size, prefix }),
  });
};

const readStableArtifactChunks = async <Value>(options: {
  readonly path: string;
  readonly maximumBytes: number;
  readonly chunkBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly fileSystem: StableArtifactFileSystem;
  readonly resourceScope: ArtifactResourceScope | undefined;
  readonly retainBytes: (size: number) => number;
  readonly onChunk: ((chunk: Buffer) => void | Promise<void>) | undefined;
  readonly complete: (
    retained: Buffer,
    sha256: string,
    size: number,
    state: BigIntStats,
  ) => Value;
}): Promise<Value> => {
  const {
    path,
    maximumBytes,
    chunkBytes,
    signal,
    fileSystem,
    resourceScope,
    retainBytes,
    onChunk,
    complete,
  } = options;
  assertArtifactReadActive(signal);
  const { before, file } = await openRegularFile(path, fileSystem, (stat) => {
    if (stat.size > BigInt(maximumBytes))
      throw new ArtifactReaderFailure(
        "limit",
        `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
        { boundary: "file-size" },
      );
  });
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await assertOpenedAdmitted(path, file, before);
      assertArtifactReadActive(signal);
      const maximumSize = BigInt(maximumBytes);
      // A raced descriptor size must not allocate beyond the selected budget.
      // These private bytes are published only after the exact count and both
      // file identities below validate, so an incomplete read exposes no tail.
      const admitted = Number(
        initial.size > maximumSize ? maximumSize : initial.size,
      );
      const bytes = Buffer.allocUnsafe(
        Math.max(0, Math.min(admitted, retainBytes(admitted))),
      );
      let overflow: Buffer | undefined;
      let eofProbe: Buffer | undefined;
      const hash = createHash("sha256");
      let count = 0;
      for (;;) {
        assertArtifactReadActive(signal);
        const inside = count < bytes.length;
        let target: Buffer;
        let offset: number;
        if (inside) {
          target = bytes;
          offset = count;
        } else {
          offset = 0;
          if (overflow !== undefined) {
            target = overflow;
          } else if (count < admitted) {
            overflow = Buffer.allocUnsafe(
              Math.min(chunkBytes, Math.max(EOF_PROBE_BYTES, admitted - count)),
            );
            target = overflow;
          } else {
            // Full-file snapshots expect EOF here; probe without allocating a full chunk.
            eofProbe ??= Buffer.allocUnsafe(
              Math.min(chunkBytes, EOF_PROBE_BYTES),
            );
            target = eofProbe;
          }
        }
        const wanted = Math.min(chunkBytes, target.length - offset);
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
        if (onChunk !== undefined) await onChunk(chunk);
      }
      await assertUnchangedAfterRead(path, file, fileSystem, initial, count);
      assertArtifactReadActive(signal);
      return complete(bytes, hash.digest("hex"), count, initial);
    },
  );
};

/**
 * Decode selected ranges of one regular file without loading it, then hash the
 * whole file through the same descriptor. The admission, ownership and change
 * checks are the ones readStableArtifact uses, so the SHA-256 identifies exactly
 * the bytes the ranges came from.
 */
export const readStableArtifactRanges = async <T>(
  path: string,
  decode: (source: StableArtifactRangeSource) => Promise<T>,
  signal?: AbortSignal,
  resourceScope?: ArtifactResourceScope,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
): Promise<{
  readonly result: T;
  readonly sha256: string;
  readonly bytes: number;
}> => {
  assertArtifactReadActive(signal);
  const { before, file } = await openRegularFile(path, fileSystem, (stat) => {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ArtifactReaderFailure(
        "limit",
        `Selected artifact is too large to address: ${path}`,
        { boundary: "file-size" },
      );
  });
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await assertOpenedAdmitted(path, file, before);
      const size = Number(initial.size);
      const result = await decode({
        size,
        read: async (offset, length) => {
          assertArtifactReadActive(signal);
          if (offset < 0 || length < 0 || offset + length > size)
            throw invariantViolation(
              `Read of ${length} bytes at ${offset} is outside ${size} bytes`,
            );
          const buffer = Buffer.alloc(length);
          let done = 0;
          while (done < length) {
            const { bytesRead } = await file.read(
              buffer,
              done,
              length - done,
              offset + done,
            );
            if (bytesRead === 0)
              throw new ArtifactReaderFailure(
                "integrity",
                `Artifact shrank during read: ${path}`,
                { integrityCheck: "container-identity" },
              );
            done += bytesRead;
          }
          return buffer;
        },
      });
      assertArtifactReadActive(signal);
      const hash = createHash("sha256");
      let count = 0;
      for await (const chunk of file.createReadStream({
        autoClose: false,
        start: 0,
        highWaterMark: 65536,
      })) {
        assertArtifactReadActive(signal);
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value))
          throw new ArtifactReaderFailure(
            "format",
            `Artifact stream did not return bytes: ${path}`,
          );
        count += value.length;
        // Stop at the first byte past the admitted size instead of following growth.
        if (count > size)
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact grew during read: ${path}`,
            { integrityCheck: "container-identity" },
          );
        hash.update(value);
      }
      await assertUnchangedAfterRead(path, file, fileSystem, initial, count);
      // A cancellation from here on is reported by the descriptor owner, which
      // keeps this completed read so the caller can still name the source.
      return { result, sha256: hash.digest("hex"), bytes: size };
    },
  );
};

/** Revalidate a completed snapshot's selected file state without reading its bytes again. */
export const assertStableArtifactState = async (
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
): Promise<void> => {
  assertArtifactReadActive(signal);
  const current = await afterValidation(path, "before cached inspection", () =>
    lstat(path, { bigint: true }),
  );
  if (!sameRegularFileState(expected, current))
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact changed since acquisition: ${path}`,
      { integrityCheck: "container-identity" },
    );
  assertArtifactReadActive(signal);
};
