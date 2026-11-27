import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  resolvedRegularFile,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { invariantViolation } from "../domain/internalInvariant.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { budgetArtifactReads } from "./artifactReadBudget.js";
import type { ArtifactReadBudget } from "../domain/artifactReadBudget.js";
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

const verifyStableArtifactRead = async (
  path: string,
  fileSystem: StableArtifactFileSystem,
  file: FileHandle,
  initial: BigIntStats,
  count: number,
): Promise<void> => {
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

const DEFAULT_STREAM_CHUNK_BYTES = 65536;
const SNAPSHOT_READ_CHUNK_BYTES = 1048576;
const EOF_PROBE_BYTES = 4096;

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
    throw invariantViolation(
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

/** Verified random-access handle for one streamed stable artifact. */
export interface StableArtifactHandle {
  readonly sha256: string;
  readonly size: number;
  readonly prefix: Buffer;
  /** Read a verified positional byte range from the open descriptor. */
  readonly readRange: (offset: number, length: number) => Promise<Buffer>;
}

/** Read an already-admitted extent and preserve the format in a read-coverage failure. */
export const readAdmittedRange = async (
  format: string,
  source: Pick<StableArtifactHandle, "readRange">,
  offset: number,
  length: number,
): Promise<Buffer> => {
  const bytes = await source.readRange(offset, length);
  if (bytes.length !== length)
    throw new ArtifactReaderFailure(
      "integrity",
      `${format} read at offset ${String(offset)} ended before its ${String(length)} admitted bytes.`,
      { integrityCheck: "read-coverage" },
    );
  return bytes;
};

/** Options for {@link withStableArtifactHandle}. */
export interface StableArtifactHandleOptions<Value = unknown> {
  /** Bytes to retain from the start of the file, given its admitted size. */
  readonly retainBytes: (size: number) => number;
  /** Maximum streaming hash chunk size in bytes; defaults to 65536. */
  readonly chunkBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fileSystem?: StableArtifactFileSystem;
  readonly resourceScope?: ArtifactResourceScope | undefined;
  /** Called once whole-file hashing and stability verification complete, before `useFile`. */
  readonly onIdentity?: (identity: {
    readonly sha256: string;
    readonly bytes: number;
  }) => void;
  /** Called after the parsed result passes the final identity check, before closing. */
  readonly onVerifiedResult?: (value: Value) => void;
  /**
   * Bound the positional reads `useFile` makes. `maximumBytes` then bounds
   * only the identity pass, which streams the whole file once.
   */
  readonly readBudget?: ArtifactReadBudget | undefined;
}

/**
 * Stream one bounded regular file to verify its identity and SHA-256 without
 * buffering the whole file, then run `useFile` with random-access reads on the
 * same open descriptor and re-verify file stability before closing.
 */
export const withStableArtifactHandle = async <Value>(
  path: string,
  maximumBytes: number,
  options: StableArtifactHandleOptions<Value>,
  useFile: (handle: StableArtifactHandle) => Promise<Value>,
): Promise<Value> => {
  const chunkBytes = options.chunkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0)
    throw invariantViolation(
      `Artifact read chunk size must be a positive integer: ${String(chunkBytes)}`,
    );
  const fileSystem = options.fileSystem ?? FILE_SYSTEM;
  return readStableArtifactChunks({
    path,
    maximumBytes,
    chunkBytes,
    signal: options.signal,
    fileSystem,
    resourceScope: options.resourceScope,
    retainBytes: options.retainBytes,
    onChunk: undefined,
    complete: async (prefix, sha256, size, initial, file) => {
      options.onIdentity?.({ sha256, bytes: size });
      const verifyState = () =>
        verifyStableArtifactRead(path, fileSystem, file, initial, size);
      const handle: StableArtifactHandle = {
        sha256,
        size,
        prefix,
        readRange: (offset, length) =>
          readFileHandleRange(file, offset, length, () =>
            assertArtifactReadActive(options.signal),
          ),
      };
      const value = await useFile(
        options.readBudget === undefined
          ? handle
          : budgetArtifactReads(handle, options.readBudget),
      ).catch(async (cause: unknown) => {
        // Format findings can reflect bytes rewritten during parsing. Keep
        // independent physical I/O, cancellation, and decoder failures primary.
        if (
          (cause instanceof ParseFailureError && cause.kind !== "limit") ||
          (cause instanceof ArtifactReaderFailure &&
            cause.parseFailure !== undefined)
        )
          await verifyState();
        throw cause;
      });
      await verifyState();
      options.onVerifiedResult?.(value);
      // The descriptor owner records this verified completion before checking
      // finalization cancellation, so cleanup errors can retain the value.
      return value;
    },
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
    file: FileHandle,
  ) => Value | Promise<Value>;
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
      { boundary: "file-size", observedBytes: before.size },
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
          { integrityCheck: "container-identity" },
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
            "io",
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
      await verifyStableArtifactRead(path, fileSystem, file, initial, count);
      assertArtifactReadActive(signal);
      return complete(bytes, hash.digest("hex"), count, initial, file);
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
