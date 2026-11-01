import { Readable, Transform, pipeline } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";

import type {
  UnityWebDataEntryMetadata,
  UnityWebDataMetadata,
} from "../domain/artifactFormatMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  parseUnityWebDataDirectory,
  readUnityWebDataDirectoryEnd,
  UNITY_WEB_DATA_MAX_DIRECTORY_BYTES,
  UNITY_WEB_DATA_PREFIX_BYTES,
  UNITY_WEB_DATA_SIGNATURE,
} from "../domain/unityWebDataFormat.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

type UnityWebDataEntry = ArtifactEntry & {
  readonly byteOffset: number;
  readonly declaredSize: number;
  readonly formatMetadata: UnityWebDataEntryMetadata;
};

/** Read a Unity WebGL `.data` container without running or altering the build. */
export class UnityWebDataArtifactReader implements ArtifactReader {
  readonly format = "unity-web-data" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, UnityWebDataEntry>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  #prepared: Promise<void> | undefined;
  #metadata: UnityWebDataMetadata | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(
      path,
      "Unity WebGL data container",
      admitted,
    );
  }

  formatMetadata(): UnityWebDataMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    options?.onCoverage?.({ status: "complete", limitations: [] });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          "Unity WebGL data entry does not match its owning inventory",
        );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  "Unity WebGL data read cancelled",
                  { cause: reason },
                ),
            });
      const output = this.#memberStream(stored, signal);
      output.on("error", () => undefined);
      this.#streams.add(output);
      let producerComplete = false;
      const onAbort = (): void => {
        // Active reads own failure precedence; afterwards cancellation still
        // retires any unconsumed readable bytes.
        if (!producerComplete || output.destroyed) return;
        output.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            "Unity WebGL data read cancelled",
            { cause: signal?.reason },
          ),
        );
      };
      const retired = new Promise<void>((resolve) => {
        output.once("close", () => {
          this.#streams.delete(output);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void this.#scope
        .run(async () => {
          await Promise.all([
            new Promise<void>((resolve) =>
              pipeline(source, output, () => {
                producerComplete = true;
                if (signal?.aborted) onAbort();
                resolve();
              }),
            ),
            retired,
          ]);
        })
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error("Unity WebGL data stream ownership failed", {
                  cause,
                }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          "Unity WebGL data reader closed",
        ),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Unity WebGL data reader closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const prefix = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, UNITY_WEB_DATA_PREFIX_BYTES),
      initial.size,
      signal,
    );
    const directoryEnd = readUnityWebDataDirectoryEnd(prefix);
    if (directoryEnd === undefined)
      throw formatFailure("signature or directory end is truncated");
    if (directoryEnd > UNITY_WEB_DATA_MAX_DIRECTORY_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Unity WebGL data directory declares ${String(directoryEnd)} bytes, above the ${String(UNITY_WEB_DATA_MAX_DIRECTORY_BYTES)}-byte directory budget`,
        { boundary: "memory" },
      );
    if (directoryEnd > initial.size)
      throw formatFailure(
        `directory end ${String(directoryEnd)} lies outside the ${String(initial.size)}-byte file`,
      );
    const directory = await readArtifactFileBytes(
      handle,
      0,
      directoryEnd,
      initial.size,
      signal,
    );
    const parsed = parseUnityWebDataDirectory(directory, initial.size);
    if (typeof parsed === "string") throw formatFailure(parsed);
    // Overlapping records would multiply readable plaintext; charge every one.
    let readable = 0;
    const budget = artifactExpansionBudgetBytes(initial.size);
    const seen = new Set<string>();
    for (const member of parsed.members) {
      readable += member.size;
      if (readable > budget)
        throw new ArtifactReaderFailure(
          "limit",
          `Unity WebGL data members declare more than ${String(budget)} readable bytes`,
          { boundary: "memory" },
        );
      if (seen.has(member.path))
        throw formatFailure(`duplicate member path: ${member.path}`);
      seen.add(member.path);
      const entry: UnityWebDataEntry = {
        path: member.path,
        kind: "file",
        declaredSize: member.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: member.offset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `unity-web-data:${String(member.index)}`,
        formatMetadata: {
          kind: "unity-web-data-entry",
          index: member.index,
          source_path: member.path,
          declared_offset: member.offset,
        },
        sourcePath: member.path,
      };
      this.#entries.set(entry.adapterKey, entry);
    }
    this.#metadata = {
      kind: "unity-web-data",
      signature: UNITY_WEB_DATA_SIGNATURE.subarray(0, 15).toString("latin1"),
      directory_end: parsed.directoryEnd,
      member_count: parsed.members.length,
    };
  }

  #memberStream(entry: UnityWebDataEntry, signal?: AbortSignal): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw formatFailure(`member ended early: ${entry.path}`);
      await this.#source.read(signal);
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error("Unity WebGL data read failed", { cause }),
            ),
        );
      },
    });
  }
}

const formatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Unity WebGL data container is malformed: ${detail}`,
  );
