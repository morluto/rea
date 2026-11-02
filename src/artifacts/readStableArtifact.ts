import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
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

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
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
    );
};

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<StableArtifactSnapshot> => {
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
      const bytes = Buffer.allocUnsafe(
        Number(initial.size > maximumSize ? maximumSize : initial.size),
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
        hash.update(target.subarray(offset, offset + bytesRead));
      }
      await assertUnchangedAfterRead(path, file, fileSystem, initial, count);
      assertArtifactReadActive(signal);
      return {
        bytes,
        sha256: hash.digest("hex"),
      };
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
            throw new RangeError(
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
