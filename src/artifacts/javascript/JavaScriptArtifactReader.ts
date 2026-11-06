import { basename } from "node:path";
import { Readable } from "node:stream";

import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import { artifactNameForClassification } from "../../domain/artifactNameSelection.js";
import { AsarArtifactReader } from "../AsarArtifactReader.js";
import { assertArtifactReadActive } from "../ArtifactFileOperation.js";
import { ArtifactFileSource } from "../ArtifactFileSource.js";
import { normalizeArtifactPath } from "../ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "../ArtifactReader.js";
import { assertArtifactSelectedSource } from "../ArtifactSelectedSource.js";
import { DirectoryArtifactReader } from "../DirectoryArtifactReader.js";
import { hostExecutableMarking } from "../hostExecutableMarking.js";
import { readArtifactFileChunks } from "../readArtifactFileChunks.js";

/** Read-only single-file reader over one admitted JavaScript/TypeScript source. */
export class SingleFileJavaScriptArtifactReader implements ArtifactReader {
  readonly format = "file" as const;
  readonly entryPath: string;
  readonly #source: ArtifactFileSource;
  readonly #activeStreams = new Map<Readable, Promise<void>>();
  #admittedEntry: ArtifactEntry | undefined;
  #closed = false;

  constructor(
    private readonly path: string,
    private readonly selectedPath?: string,
  ) {
    this.entryPath = normalizeArtifactPath(
      basename(artifactNameForClassification(selectedPath ?? path, path)),
    );
    this.#source = new ArtifactFileSource(path, "JavaScript source file");
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "JavaScript source file reader is closed",
      );
    assertArtifactReadActive(signal);
    await assertArtifactSelectedSource(this.path, this.selectedPath);
    const source = await this.#source.readSelectedPath(signal);
    const entry: ArtifactEntry = {
      path: this.entryPath,
      kind: "file",
      declaredSize: source.initial.size,
      compressedSize: null,
      executable: hostExecutableMarking(this.path, source.initial),
      encrypted: false,
      byteOffset: 0,
      byteLength: source.initial.size,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: this.path,
    };
    this.#admittedEntry = copyArtifactEntry(entry);
    yield copyArtifactEntry(entry);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "JavaScript source file reader is closed",
      );
    assertArtifactReadActive(signal);
    if (
      this.#admittedEntry === undefined ||
      !sameArtifactEntry(entry, this.#admittedEntry)
    )
      throw new ArtifactReaderFailure(
        "path",
        `Artifact entry does not belong to this single-file reader: ${entry.path}`,
      );
    await assertArtifactSelectedSource(this.path, this.selectedPath);
    const source = await this.#source.readSelectedPath(signal);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const stream = Readable.from(
      this.#readVerifiedBytes(source.initial.size, resolveDone, signal),
      { objectMode: false },
    );
    this.#activeStreams.set(stream, done);
    stream.once("close", () => {
      this.#activeStreams.delete(stream);
      resolveDone();
    });
    return stream;
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const stream of this.#activeStreams.keys()) {
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          "JavaScript source file reader closed during read",
        ),
      );
    }
    await Promise.allSettled(this.#activeStreams.values());
    await this.#source.close();
  }

  async *#readVerifiedBytes(
    expectedSize: number,
    onDone: () => void,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    try {
      const source = await this.#source.readSelectedPath(signal);
      const expectedBytes = BigInt(expectedSize);
      let observedBytes = 0n;
      for await (const chunk of readArtifactFileChunks(source.handle, {
        end: expectedBytes,
        signal,
      })) {
        assertArtifactReadActive(signal);
        observedBytes += BigInt(chunk.length);
        yield chunk;
      }
      assertArtifactReadActive(signal);
      await assertArtifactSelectedSource(this.path, this.selectedPath);
      await this.#source.readSelectedPath(signal);
      if (observedBytes !== expectedBytes)
        throw new ArtifactReaderFailure(
          "integrity",
          `JavaScript source file changed during read: ${this.entryPath}`,
        );
    } finally {
      onDone();
    }
  }
}

/** Create the reader for an admitted JavaScript artifact format. */
export const createJavaScriptArtifactReader = (
  path: string,
  format: "asar" | "directory" | "file",
  asarHeaderAdmission?: AsarHeaderAdmission,
  selectedPath?: string,
): ArtifactReader =>
  format === "asar"
    ? new AsarArtifactReader(path, {
        ...(asarHeaderAdmission === undefined
          ? {}
          : { headerAdmission: asarHeaderAdmission }),
        ...(selectedPath === undefined ? {} : { selectedPath }),
      })
    : format === "file"
      ? new SingleFileJavaScriptArtifactReader(path, selectedPath)
      : new DirectoryArtifactReader(path, "omit");
