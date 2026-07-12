import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { streamChunkToBuffer } from "./StreamBytes.js";

import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  type ArtifactLimits,
} from "./ArtifactReader.js";

/** One file durably written to a transaction-owned output tree. */
export interface SafeOutputFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytesWritten: number;
}

/** Cleanup facts established while rolling back an uncommitted tree. */
export interface SafeOutputCleanup {
  readonly attempted: boolean;
  readonly verified: boolean;
  readonly residualPaths: readonly string[];
}

/** Transactional, symlink-resistant materialization beneath an absent path. */
export class SafeOutputTree {
  readonly #registry = new ArtifactPathRegistry();
  readonly #limits: ArtifactLimits;
  readonly #outputRoot: string;
  readonly #stagingRoot: string;
  #totalBytes = 0;
  #published = false;
  #cleanup: SafeOutputCleanup = {
    attempted: false,
    verified: false,
    residualPaths: [],
  };

  private constructor(
    outputRoot: string,
    stagingRoot: string,
    limits: ArtifactLimits,
  ) {
    this.#outputRoot = outputRoot;
    this.#stagingRoot = stagingRoot;
    this.#limits = limits;
  }

  /** Exclusively create the absent destination as this transaction's owned tree. */
  static async create(
    outputRoot: string,
    limits: ArtifactLimits,
  ): Promise<SafeOutputTree> {
    if (!isAbsolute(outputRoot))
      throw new ArtifactReaderFailure(
        "path",
        "Extraction output root must be absolute",
      );
    const requested = resolve(outputRoot);
    const name = basename(requested);
    if (name === "." || name === "..")
      throw new ArtifactReaderFailure("path", "Invalid extraction output root");
    const parent = await realpath(dirname(requested)).catch(
      (cause: unknown) => {
        throw new ArtifactReaderFailure(
          "unavailable",
          "Extraction output parent is unavailable",
          { cause },
        );
      },
    );
    const canonicalOutput = join(parent, name);
    await mkdir(canonicalOutput, { mode: 0o700 }).catch((cause: unknown) => {
      if (isAlreadyExists(cause))
        throw new ArtifactReaderFailure(
          "path",
          "Extraction output root already exists",
          { cause },
        );
      throw cause;
    });
    try {
      const stagingHandle = await open(
        canonicalOutput,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await stagingHandle.chmod(0o700);
      } finally {
        await stagingHandle.close();
      }
      return new SafeOutputTree(canonicalOutput, canonicalOutput, limits);
    } catch (cause: unknown) {
      await rm(canonicalOutput, { recursive: true, force: true });
      throw cause;
    }
  }

  get outputRoot(): string {
    return this.#outputRoot;
  }

  get cleanup(): SafeOutputCleanup {
    return this.#cleanup;
  }

  /** Stream one selected regular file with exact byte and digest verification. */
  async write(
    relativePath: string,
    source: Readable,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<SafeOutputFile> {
    this.#assertWritable();
    const path = normalizeArtifactPath(relativePath, this.#limits);
    this.#registry.add(path, "file");
    const destination = await this.#prepareParent(path);
    const handle = await open(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    ).catch((cause: unknown) => {
      throw new ArtifactReaderFailure(
        "path",
        `Could not exclusively create extraction path: ${path}`,
        { cause },
      );
    });
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const raw of source) {
        abortIfNeeded(signal);
        const chunk = streamChunkToBuffer(raw);
        bytes += chunk.length;
        if (bytes > this.#limits.maxEntryBytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Observed entry bytes exceed limit: ${path}`,
          );
        if (this.#totalBytes + bytes > this.#limits.maxTotalBytes)
          throw new ArtifactReaderFailure(
            "limit",
            "Observed extraction bytes exceed cumulative limit",
          );
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      const sha256 = hash.digest("hex");
      if (sha256 !== expectedSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          `Extracted content disagrees with inventory: ${path}`,
        );
      await handle.sync();
      await handle.close();
      const readback = await hashFile(destination, bytes, signal);
      if (readback.sha256 !== sha256 || readback.bytes !== bytes)
        throw new ArtifactReaderFailure(
          "integrity",
          `Durable readback verification failed: ${path}`,
        );
      this.#totalBytes += bytes;
      return { relativePath: path, sha256, bytesWritten: bytes };
    } catch (cause: unknown) {
      await handle.close().catch(() => undefined);
      throw cause;
    }
  }

  /** Durably commit the exclusively-created output tree. */
  async commit(): Promise<void> {
    this.#assertWritable();
    const parent = await open(
      dirname(this.#outputRoot),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const staging = await open(
      this.#stagingRoot,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await staging.sync();
      await parent.sync();
      this.#published = true;
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "path",
        "Could not durably commit extraction output",
        { cause },
      );
    } finally {
      await Promise.allSettled([parent.close(), staging.close()]);
    }
  }

  /** Remove only this transaction's uncommitted tree and verify absence. */
  async rollback(): Promise<SafeOutputCleanup> {
    if (this.#published) return this.#cleanup;
    await rm(this.#stagingRoot, { recursive: true, force: true });
    const absent = await isAbsent(this.#stagingRoot);
    this.#cleanup = {
      attempted: true,
      verified: absent,
      residualPaths: absent ? [] : [basename(this.#stagingRoot)],
    };
    if (!absent)
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction output cleanup could not be verified",
      );
    return this.#cleanup;
  }

  async #prepareParent(relativePath: string): Promise<string> {
    const parts = relativePath.split("/");
    const fileName = parts.pop();
    if (fileName === undefined)
      throw new ArtifactReaderFailure("path", "Invalid extraction path");
    let current = this.#stagingRoot;
    for (const part of parts) {
      current = join(current, part);
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (!isAlreadyExists(cause)) throw cause;
      });
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new ArtifactReaderFailure(
          "path",
          `Unsafe extraction parent: ${relativePath}`,
        );
    }
    return join(current, fileName);
  }

  #assertWritable(): void {
    if (this.#published)
      throw new ArtifactReaderFailure(
        "integrity",
        "Extraction tree is already committed",
      );
  }
}

const hashFile = async (
  path: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of handle.createReadStream({ autoClose: false })) {
      abortIfNeeded(signal);
      const chunk = streamChunkToBuffer(raw);
      bytes += chunk.length;
      if (bytes > maximum)
        throw new ArtifactReaderFailure(
          "integrity",
          "Readback exceeded the bytes written",
        );
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes };
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten === 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Extraction output stopped accepting bytes",
      );
    offset += bytesWritten;
  }
};

const isAbsent = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => false,
    (cause: unknown) => {
      if (isNotFound(cause)) return true;
      throw cause;
    },
  );

const isNotFound = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const isAlreadyExists = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST";

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact extraction cancelled",
    );
};
