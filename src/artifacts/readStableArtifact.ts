import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import { ArtifactReaderFailure, resolvedPathRetry } from "./ArtifactReader.js";
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
  /** Names a refused symlink's target for recovery; it never admits that target. */
  realpath?(path: string): Promise<string>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
  realpath,
};

/**
 * Refuse a selected symlink while naming its current target, so a caller can
 * deliberately select that canonical path. The target is only reported: the
 * read never follows it, because the selected spelling would otherwise stop
 * identifying the bytes that were read.
 */
const selectedPathFailure = async (
  path: string,
  metadata: BigIntStats,
  fileSystem: StableArtifactFileSystem,
): Promise<ArtifactReaderFailure> => {
  const message = `Expected a regular file without a symlink: ${path}`;
  if (!metadata.isSymbolicLink() || fileSystem.realpath === undefined)
    return new ArtifactReaderFailure("path", message);
  let target: string;
  try {
    target = await fileSystem.realpath(path);
  } catch (cause) {
    if (artifactSelectedPathErrno(cause) !== undefined)
      return new ArtifactReaderFailure(
        "path",
        `${message} (its target does not currently resolve)`,
        {
          cause,
          userMessage: `The selected path is a symlink whose target does not currently resolve: ${path}. Select an existing regular file directly, then retry.`,
        },
      );
    // The target may exist but be unreachable (EACCES, EIO, ...): keep the
    // refusal, but report the lookup failure instead of calling it dangling.
    const code =
      cause instanceof Error &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : "unknown error";
    return new ArtifactReaderFailure(
      "path",
      `${message} (its target could not be resolved: ${code})`,
      {
        cause,
        userMessage: `The selected path is a symlink whose target could not be resolved (${code}): ${path}. Check access to the link's target, or select the intended regular file directly, then retry.`,
      },
    );
  }
  // Offer the target as a retry only when it is a regular file now; a link to
  // a directory or another special file gets no resolved-file hint.
  try {
    const resolved = await fileSystem.lstat(target);
    if (resolved.isFile() && !resolved.isSymbolicLink())
      return new ArtifactReaderFailure(
        "path",
        `${message} (it resolves to ${target})`,
        { resolvedPath: target, userMessage: resolvedPathRetry(target) },
      );
  } catch {
    // A missing or unreadable target changes only the recovery hint.
  }
  return new ArtifactReaderFailure("path", message);
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
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<StableArtifactSnapshot> => {
  assertArtifactReadActive(signal);
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw await selectedPathFailure(path, before, fileSystem);
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
      return {
        bytes,
        sha256: hash.digest("hex"),
      };
    },
  );
};
