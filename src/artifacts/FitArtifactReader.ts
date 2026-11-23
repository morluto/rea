import { setImmediate } from "node:timers/promises";

import type { FitMetadata } from "../domain/artifactFormatMetadata.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import {
  FDT_MAX_HEADER_BYTES,
  readDevicetreeHeader,
} from "../domain/firmware/devicetreeHeader.js";
import { MAX_DEVICETREE_FILE_BYTES } from "../domain/firmware/devicetree.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import {
  createFitDigest,
  readFitStructure,
  type FitImageDeclaration,
} from "./fit/FitStructure.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";

/** Inventory U-Boot FIT /images nodes as stored byte ranges without loading them. */
export class FitArtifactReader extends PositionalArtifactReader<FitMetadata> {
  override readonly format = "fit" as const;
  readonly #path: string;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    super(path, "FIT", admitted);
    this.#path = path;
  }

  formatMetadata(): FitMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override entryEndedEarly(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure {
    return new ArtifactReaderFailure(
      "format",
      `FIT image ended early: ${entry.path}`,
    );
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<FitMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const assertActive = (): void => this.assertOpen(signal);
    const prefix = await readFileHandleRange(
      handle,
      0,
      FDT_MAX_HEADER_BYTES,
      assertActive,
    );
    let totalsize: number;
    try {
      ({ totalsize } = readDevicetreeHeader(prefix).header);
    } catch (cause) {
      if (cause instanceof BinaryFormatFailure)
        throw new ArtifactReaderFailure(
          "format",
          `FIT devicetree header: ${cause.message}`,
        );
      throw cause;
    }
    if (totalsize > initial.size)
      throw new ArtifactReaderFailure(
        "format",
        `FIT devicetree is truncated: totalsize ${String(totalsize)} exceeds the ${String(initial.size)}-byte file`,
      );
    if (totalsize > MAX_DEVICETREE_FILE_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `FIT devicetree is ${String(totalsize)} bytes, above the fixed 16 MiB devicetree allowance; embedded image data this large is not supported (mkimage -E stores data externally). No runtime override.`,
        { boundary: "memory" },
      );
    // Only the devicetree is read; external image data stays on disk.
    const structure = readFitStructure(
      await readFileHandleRange(handle, 0, totalsize, assertActive),
      this.#path,
      initial.size,
    );
    const entries: PositionalArtifactEntry[] = [];
    let index = 0;
    for (const image of structure.images) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.assertOpen(signal);
      await this.#verifyHashes(image, signal);
      entries.push({
        path: `images/${image.name}.bin`,
        sourcePath: `/images/${image.name}`,
        kind: "file" as const,
        declaredSize: image.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: image.start,
        declaredIntegrity: null,
        unpacked: false,
        limitations: image.limitations,
        adapterKey: `fit:${String(image.index)}`,
        formatMetadata: image.metadata,
      });
    }
    return {
      entries,
      coverage: {
        status: "complete",
        limitations: structure.limitations,
      },
      formatMetadata: structure.metadata,
    };
  }

  /** One streamed pass per image feeds every supported digest. */
  async #verifyHashes(
    image: FitImageDeclaration,
    signal?: AbortSignal,
  ): Promise<void> {
    const digests = image.hashes.flatMap((hash) => {
      const digest = createFitDigest(hash.algo);
      return digest === undefined ? [] : [{ hash, digest }];
    });
    if (digests.length === 0) return;
    const { handle } = await this.verifyCarrier(signal);
    if (image.size > 0)
      for await (const chunk of readFileHandleChunks(handle, {
        start: image.start,
        end: image.start + image.size - 1,
        signal,
        cancellationFailure: hashReadCancelled,
      }) as AsyncIterable<Buffer>) {
        this.assertOpen(signal);
        for (const { digest } of digests) digest.update(chunk);
      }
    for (const { hash, digest } of digests) {
      const computed = digest.digest();
      if (!computed.equals(hash.value))
        throw new ArtifactReaderFailure(
          "integrity",
          `FIT image ${image.name} ${hash.node} ${hash.algo} does not match: declared ${hash.value.toString("hex")}, computed ${computed.toString("hex")}`,
          { integrityCheck: "declared-digest" },
        );
    }
  }
}

const hashReadCancelled = (reason: unknown): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "FIT read cancelled", {
    cause: reason,
  });
