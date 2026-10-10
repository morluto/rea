import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { streamChunkToBuffer } from "./StreamBytes.js";

import {
  ArtifactPathRegistry,
  destinationCaseCollisionMessage,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** One file durably written to an operation-owned output tree. */
export interface SafeOutputFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytesWritten: number;
}

/** Cleanup state established while rolling back an uncommitted tree. */
export type SafeOutputCleanup =
  | { readonly status: "not-required" }
  | { readonly status: "complete"; readonly residualPaths: readonly [] }
  | {
      readonly status: "incomplete";
      readonly residualPaths: readonly [string, ...string[]];
    };

/** Symlink-resistant materialization in an exclusively owned, initially absent tree. */
export class SafeOutputTree {
  readonly #registry = new ArtifactPathRegistry();
  readonly #outputRoot: string;
  #published = false;
  #cleanup: SafeOutputCleanup = {
    status: "not-required",
  };

  private constructor(
    outputRoot: string,
    private readonly platform: NodeJS.Platform,
  ) {
    this.#outputRoot = outputRoot;
  }

  /**
   * Exclusively create the absent destination as this operation's owned tree.
   *
   * POSIX mode bits and directory `fchmod`/`fsync` have no Windows equivalent:
   * `mkdir` already applies the requested mode, so the redundant handle
   * `chmod` is skipped there to avoid an `EPERM` on the directory descriptor.
   */
  static async create(
    outputRoot: string,
    platform: NodeJS.Platform = process.platform,
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
      if (platform !== "win32") {
        const stagingHandle = await open(
          canonicalOutput,
          constants.O_RDONLY | constants.O_DIRECTORY,
        );
        try {
          await stagingHandle.chmod(0o700);
        } finally {
          await stagingHandle.close();
        }
      }
      return new SafeOutputTree(canonicalOutput, platform);
    } catch (cause: unknown) {
      let removalFailure: unknown;
      try {
        await rm(canonicalOutput, { recursive: true, force: true });
      } catch (cleanupCause: unknown) {
        removalFailure = cleanupCause;
      }
      let absent = false;
      try {
        absent = await isAbsent(canonicalOutput);
      } catch (cleanupCause: unknown) {
        removalFailure ??= cleanupCause;
      }
      if (!absent)
        throw ArtifactReaderFailure.withCleanup(cause, {
          reason:
            removalFailure instanceof Error
              ? removalFailure.message
              : "Extraction output root remains after setup failure",
          resources: [canonicalOutput],
        });
      throw cause;
    }
  }

  get outputRoot(): string {
    return this.#outputRoot;
  }

  get cleanup(): SafeOutputCleanup {
    return structuredClone(this.#cleanup);
  }

  /** Stream one regular file with exact byte and digest verification. */
  async write(
    relativePath: string,
    source: Readable,
    expected: { readonly sha256: string; readonly bytes: number },
    signal?: AbortSignal,
  ): Promise<SafeOutputFile> {
    try {
      this.#assertWritable();
      if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0)
        throw new ArtifactReaderFailure(
          "format",
          `Invalid expected extraction size for ${relativePath}`,
        );
      const path = normalizeArtifactPath(relativePath);
      // Win32 interprets a colon in any component as stream syntax, not a literal name.
      if (this.platform === "win32" && path.includes(":"))
        throw new ArtifactReaderFailure(
          "path",
          `Windows destination cannot materialize artifact path as a regular file: ${path}; ':' denotes alternate data stream syntax. Inventory retains the logical name.`,
        );
      this.#registry.add(path, "file");
      const destination = await this.#prepareParent(path);
      const handle = await open(
        destination,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      ).catch(async (cause: unknown) => {
        await throwIfDestinationCaseCollision(
          dirname(destination),
          path,
          cause,
        );
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
          if (chunk.length > expected.bytes - bytes)
            throw new ArtifactReaderFailure(
              "integrity",
              `Extracted content exceeds the inventoried size: ${path}`,
            );
          bytes += chunk.length;
          hash.update(chunk);
          await writeAll(handle, chunk);
        }
        if (bytes !== expected.bytes)
          throw new ArtifactReaderFailure(
            "integrity",
            `Extracted content size disagrees with inventory: ${path}`,
          );
        const sha256 = hash.digest("hex");
        if (sha256 !== expected.sha256)
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
        return { relativePath: path, sha256, bytesWritten: bytes };
      } catch (cause: unknown) {
        // best-effort cleanup: file-handle close must not mask the write failure.
        await handle.close().catch(() => undefined);
        throw cause;
      }
    } catch (cause: unknown) {
      try {
        source.destroy();
      } catch {
        // Preserve the write refusal or failure as the caller-visible error.
      }
      throw cause;
    }
  }

  /** Sync the owned output tree and prevent further writes through this instance. */
  async commit(): Promise<void> {
    this.#assertWritable();
    // Windows has no directory fsync; file contents are already synced in write().
    if (this.platform === "win32") {
      this.#published = true;
      return;
    }
    const parent = await open(
      dirname(this.#outputRoot),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    let output: FileHandle | undefined;
    try {
      output = await open(
        this.#outputRoot,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      await output.sync();
      await parent.sync();
      this.#published = true;
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "path",
        "Could not durably sync extraction output",
        { cause },
      );
    } finally {
      await Promise.allSettled([parent.close(), output?.close()]);
    }
  }

  /** Remove only this operation's unsealed tree and verify absence. */
  async rollback(): Promise<SafeOutputCleanup> {
    if (this.#published) return structuredClone(this.#cleanup);
    let removalFailure: unknown;
    try {
      await rm(this.#outputRoot, { recursive: true, force: true });
    } catch (cause: unknown) {
      removalFailure = cause;
    }
    const absent = await isAbsent(this.#outputRoot);
    this.#cleanup = absent
      ? { status: "complete", residualPaths: [] }
      : {
          status: "incomplete",
          residualPaths: [basename(this.#outputRoot)],
        };
    if (!absent)
      throw new ArtifactReaderFailure(
        "integrity",
        `Extraction output cleanup could not be verified${removalFailure === undefined ? "" : `: ${removalFailure instanceof Error ? removalFailure.message : String(removalFailure)}`}`,
        {
          cause: removalFailure,
          cleanup: {
            reason:
              removalFailure instanceof Error
                ? removalFailure.message
                : "Extraction output root remains after rollback",
            resources: [this.#outputRoot],
          },
        },
      );
    return structuredClone(this.#cleanup);
  }

  async #prepareParent(relativePath: string): Promise<string> {
    const parts = relativePath.split("/");
    const fileName = parts.pop();
    if (fileName === undefined)
      throw new ArtifactReaderFailure("path", "Invalid extraction path");
    let current = this.#outputRoot;
    let logicalParent = "";
    for (const part of parts) {
      const parentDirectory = current;
      const logicalPath =
        logicalParent.length === 0 ? part : `${logicalParent}/${part}`;
      current = join(current, part);
      let created = true;
      await mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (!isAlreadyExists(cause)) throw cause;
        created = false;
      });
      if (!created)
        await throwIfDestinationCaseCollision(parentDirectory, logicalPath);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        await throwIfDestinationCaseCollision(parentDirectory, logicalPath);
        throw new ArtifactReaderFailure(
          "path",
          `Unsafe extraction parent: ${relativePath}`,
        );
      }
      logicalParent = logicalPath;
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

/** Fail when this directory already holds another spelling of the requested segment. */
const throwIfDestinationCaseCollision = async (
  parentDirectory: string,
  logicalPath: string,
  cause?: unknown,
): Promise<void> => {
  const names = await readdir(parentDirectory).catch(() => undefined);
  if (names === undefined) return;
  const message = destinationCaseCollisionMessage(logicalPath, names);
  if (message === undefined) return;
  throw new ArtifactReaderFailure(
    "path",
    message,
    cause === undefined ? undefined : { cause },
  );
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact extraction cancelled",
    );
};
