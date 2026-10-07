import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> => {
  signal?.throwIfAborted();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  if (before.size > BigInt(maximumBytes))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
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
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 65536,
    })) {
      signal?.throwIfAborted();
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value))
        throw new ArtifactReaderFailure(
          "format",
          `Artifact stream did not return bytes: ${path}`,
        );
      const bytes = value;
      count += bytes.length;
      if (count > maximumBytes)
        throw new ArtifactReaderFailure(
          "limit",
          `Selected artifact grew beyond its byte limit: ${path}`,
        );
      chunks.push(bytes);
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      [after, current].some(
        (stat) =>
          !stat.isFile() ||
          stat.dev !== initial.dev ||
          stat.ino !== initial.ino ||
          stat.size !== initial.size ||
          stat.mtimeNs !== initial.mtimeNs ||
          stat.ctimeNs !== initial.ctimeNs,
      ) ||
      BigInt(count) !== initial.size
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed during read: ${path}`,
      );
    const bytes = Buffer.concat(chunks, count);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await file.close();
  }
};
