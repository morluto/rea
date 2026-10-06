import { createReadStream } from "node:fs";
import { sep } from "node:path";
import { Readable } from "node:stream";

import { extractFile, listPackage, statFile, uncache } from "@electron/asar";

import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";

/**
 * Official Electron ASAR adapter. Individual files remain caller-bounded.
 *
 * An entry marked `unpacked` is metadata, not an integrity exemption: Electron
 * stores its bytes beside the archive in `<archive>.unpacked`, and callers must
 * hash those companion bytes against the archive's declared integrity value.
 */
export class AsarArtifactReader implements ArtifactReader {
  readonly format = "asar" as const;

  constructor(private readonly path: string) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    let paths: string[];
    try {
      // ASAR caches headers by path even after the archive has been replaced.
      uncache(this.path);
      paths = listPackage(this.path, { isPack: false }).sort((left, right) =>
        left.localeCompare(right, "en"),
      );
    } catch (cause: unknown) {
      throw asarFailure(this.path, "inventory", cause);
    }
    for (const listed of paths) {
      abortIfNeeded(signal);
      // @electron/asar returns paths assembled with the host path module.
      // Keep that spelling for its API calls, but expose archive paths with
      // portable separators. On POSIX, backslashes can be literal filename
      // characters and must remain untouched.
      const path = toArtifactPath(listed);
      if (path.length === 0) continue;
      const providerPath = listed.startsWith(sep)
        ? listed.slice(sep.length)
        : listed;
      let metadata: ReturnType<typeof statFile>;
      try {
        metadata = statFile(this.path, providerPath, false);
      } catch (cause: unknown) {
        throw asarFailure(this.path, `stat ${path}`, cause);
      }
      const kind =
        "files" in metadata
          ? "directory"
          : "link" in metadata
            ? "symlink"
            : "file";
      yield {
        path,
        kind,
        declaredSize: "size" in metadata ? metadata.size : null,
        compressedSize: null,
        executable: "executable" in metadata && metadata.executable,
        encrypted: false,
        byteOffset: null,
        declaredSha256:
          "integrity" in metadata &&
          metadata.integrity.algorithm === "SHA256" &&
          /^[a-f0-9]{64}$/u.test(metadata.integrity.hash)
            ? metadata.integrity.hash
            : null,
        unpacked: "unpacked" in metadata && metadata.unpacked === true,
        limitations:
          kind === "symlink"
            ? ["ASAR symlink target was not followed or disclosed."]
            : [
                "Official ASAR extraction buffers each individually bounded file.",
              ],
        adapterKey: providerPath,
      };
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    if (entry.kind !== "file")
      return Promise.reject(
        new ArtifactReaderFailure("format", "ASAR entry is not a regular file"),
      );
    try {
      return Promise.resolve(
        Readable.from(extractFile(this.path, entry.adapterKey, false)),
      );
    } catch (cause: unknown) {
      if (entry.unpacked && isMissingFile(cause))
        return Promise.reject(
          new ArtifactReaderFailure(
            "unavailable",
            `ASAR unpacked entry bytes are unavailable: ${entry.path}`,
            { cause },
            {
              logicalPath: entry.path,
              declaredSha256: entry.declaredSha256,
              calculatedSha256: null,
              unpacked: true,
            },
          ),
        );
      return Promise.reject(
        asarFailure(this.path, `read ${entry.path}`, cause),
      );
    }
  }

  /** Open raw container bytes to verify the inventory identity before analysis. */
  openContainer(signal?: AbortSignal): Readable {
    abortIfNeeded(signal);
    return createReadStream(this.path, signal === undefined ? {} : { signal });
  }

  close(): Promise<void> {
    uncache(this.path);
    return Promise.resolve();
  }

  provenance(): readonly [] {
    return [];
  }
}

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "ASAR operation cancelled");
};

const toArtifactPath = (listed: string): string => {
  const portable = sep === "\\" ? listed.replaceAll("\\", "/") : listed;
  return portable.replace(/^\/+|\/+$/gu, "");
};

const asarFailure = (
  path: string,
  operation: string,
  cause: unknown,
): ArtifactReaderFailure =>
  cause instanceof ArtifactReaderFailure
    ? cause
    : new ArtifactReaderFailure(
        "format",
        `Malformed or unreadable ASAR during ${operation}: ${path}`,
        { cause },
      );

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
