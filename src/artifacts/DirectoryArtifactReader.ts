import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

/** Deterministic, non-symlink-following directory reader. */
export class DirectoryArtifactReader implements ArtifactReader {
  readonly format = "directory" as const;
  readonly #rootPromise: Promise<string>;
  readonly #rootPath: string;

  constructor(root: string) {
    this.#rootPath = root;
    this.#rootPromise = realpath(root);
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const root = await this.#rootPromise.catch((cause: unknown) => {
      throw directoryIoFailure("resolve artifact root", this.#rootPath, cause);
    });
    const pending = [root];
    while (pending.length > 0) {
      abortIfNeeded(signal);
      const directory = pending.pop();
      if (directory === undefined) break;
      await withDirectoryIoContext("inspect directory", directory, () =>
        assertContainedDirectory(root, directory),
      );
      const children: string[] = [];
      const handle = await opendir(directory).catch((cause: unknown) => {
        throw directoryIoFailure("open directory", directory, cause);
      });
      try {
        for await (const child of handle) children.push(child.name);
      } catch (cause: unknown) {
        throw directoryIoFailure("read directory", directory, cause);
      } finally {
        // best-effort cleanup: directory-handle close must not mask traversal.
        await handle.close().catch(() => undefined);
      }
      await withDirectoryIoContext("inspect directory", directory, () =>
        assertContainedDirectory(root, directory),
      );
      children.sort(compareUnicodeCodePoints);
      const directories: string[] = [];
      for (const name of children) {
        abortIfNeeded(signal);
        const absolute = join(directory, name);
        const metadata = await lstat(absolute).catch((cause: unknown) => {
          throw directoryIoFailure("inspect entry", absolute, cause);
        });
        const path = relative(root, absolute).split(sep).join("/");
        const kind = metadata.isSymbolicLink()
          ? "symlink"
          : metadata.isDirectory()
            ? "directory"
            : metadata.isFile()
              ? "file"
              : undefined;
        if (kind === undefined) continue;
        if (kind === "directory") directories.push(absolute);
        yield {
          path,
          kind,
          declaredSize: kind === "file" ? metadata.size : null,
          compressedSize: null,
          executable: (metadata.mode & 0o111) !== 0,
          encrypted: false,
          byteOffset: null,
          declaredSha256: null,
          unpacked: false,
          limitations:
            kind === "symlink"
              ? ["Symlink target was not followed or disclosed."]
              : [],
          adapterKey: absolute,
          ...(kind === "file"
            ? { sourceIdentity: { device: metadata.dev, inode: metadata.ino } }
            : {}),
        };
      }
      directories.reverse();
      pending.push(...directories);
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    if (entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        "Only regular files can be opened",
      );
    const handle = await open(
      entry.adapterKey,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((cause: unknown) => {
      throw directoryIoFailure("open entry", entry.adapterKey, cause);
    });
    try {
      const observed = await handle.stat().catch((cause: unknown) => {
        throw directoryIoFailure(
          "inspect opened entry",
          entry.adapterKey,
          cause,
        );
      });
      if (
        !observed.isFile() ||
        entry.sourceIdentity === undefined ||
        observed.dev !== entry.sourceIdentity.device ||
        observed.ino !== entry.sourceIdentity.inode
      ) {
        throw new ArtifactReaderFailure(
          "integrity",
          `Directory entry changed before open: ${entry.path}`,
        );
      }
      return handle.createReadStream({ autoClose: true });
    } catch (cause: unknown) {
      // best-effort cleanup: file-handle close must not mask the open failure.
      await handle.close().catch(() => undefined);
      throw cause;
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  provenance(): readonly [] {
    return [];
  }
}

const directoryIoFailure = (
  operation: string,
  path: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
      ? ` (${cause.code})`
      : "";
  return new ArtifactReaderFailure(
    "io",
    `Could not ${operation} at ${path}${code}`,
    { cause },
  );
};

const withDirectoryIoContext = async <T>(
  operation: string,
  path: string,
  action: () => Promise<T>,
): Promise<T> => {
  try {
    return await action();
  } catch (cause: unknown) {
    throw directoryIoFailure(operation, path, cause);
  }
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact traversal cancelled",
    );
};

const assertContainedDirectory = async (
  root: string,
  directory: string,
): Promise<void> => {
  const canonical = await realpath(directory);
  const fromRoot = relative(root, canonical);
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new ArtifactReaderFailure(
      "path",
      "Directory traversal escaped or changed its artifact root",
    );
};
