import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

/** Deterministic, non-symlink-following directory reader. */
export class DirectoryArtifactReader implements ArtifactReader {
  readonly format = "directory" as const;
  readonly #rootPromise: Promise<string>;

  constructor(root: string) {
    this.#rootPromise = realpath(root);
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const root = await this.#rootPromise;
    const pending = [root];
    while (pending.length > 0) {
      abortIfNeeded(signal);
      const directory = pending.pop();
      if (directory === undefined) break;
      await assertContainedDirectory(root, directory);
      const children: string[] = [];
      const handle = await opendir(directory);
      try {
        for await (const child of handle) children.push(child.name);
      } finally {
        await handle.close().catch(() => undefined);
      }
      await assertContainedDirectory(root, directory);
      children.sort((left, right) => left.localeCompare(right, "en"));
      const directories: string[] = [];
      for (const name of children) {
        abortIfNeeded(signal);
        const absolute = join(directory, name);
        const metadata = await lstat(absolute);
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
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const observed = await handle.stat();
    if (
      !observed.isFile() ||
      entry.sourceIdentity === undefined ||
      observed.dev !== entry.sourceIdentity.device ||
      observed.ino !== entry.sourceIdentity.inode
    ) {
      await handle.close();
      throw new ArtifactReaderFailure(
        "integrity",
        `Directory entry changed before open: ${entry.path}`,
      );
    }
    return handle.createReadStream({ autoClose: true });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  provenance(): readonly [] {
    return [];
  }
}

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
