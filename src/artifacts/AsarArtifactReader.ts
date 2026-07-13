import { Readable } from "node:stream";

import { extractFile, listPackage, statFile } from "@electron/asar";

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
    const paths = listPackage(this.path, { isPack: false }).sort(
      (left, right) => left.localeCompare(right, "en"),
    );
    for (const listed of paths) {
      abortIfNeeded(signal);
      const path = listed.replace(/^\/+|\/+$/gu, "");
      if (path.length === 0) continue;
      const metadata = statFile(this.path, path, false);
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
        adapterKey: path,
      };
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    if (entry.kind !== "file")
      return Promise.reject(
        new ArtifactReaderFailure("format", "ASAR entry is not a regular file"),
      );
    return Promise.resolve(
      Readable.from(extractFile(this.path, entry.adapterKey, false)),
    );
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
    throw new ArtifactReaderFailure("cancelled", "ASAR operation cancelled");
};
