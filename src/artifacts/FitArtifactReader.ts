import { setImmediate } from "node:timers/promises";

import type { FitMetadata } from "../domain/formatMetadata/firmwareMetadata.js";
import type { ArtifactIntegrityClaim } from "../domain/artifactIntegrity.js";
import type { ArtifactIntegrityPolicyName } from "../domain/artifactIntegrityPolicy.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import {
  FDT_MAX_HEADER_BYTES,
  readDevicetreeHeader,
} from "../domain/firmware/devicetreeHeader.js";
import { MAX_DEVICETREE_FILE_BYTES } from "../domain/firmware/devicetree.js";
import {
  ArtifactReaderFailure,
  malformedArtifact,
  truncatedArtifact,
} from "../resources/index.js";
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
  readonly #integrity: ArtifactIntegrityPolicyName;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    integrity: ArtifactIntegrityPolicyName = "fail",
  ) {
    super(path, "FIT", admitted);
    this.#path = path;
    this.#integrity = integrity;
  }

  formatMetadata(): FitMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override entryEndedEarly(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure {
    return malformedArtifact("fit", `FIT image ended early: ${entry.path}`);
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
        throw malformedArtifact(
          "fit",
          `FIT devicetree header: ${cause.message}`,
          {
            cause,
            offset: 0,
            field: "devicetree-header",
          },
        );
      throw cause;
    }
    if (totalsize > initial.size)
      throw truncatedArtifact(
        "fit",
        `FIT devicetree is truncated: totalsize ${String(totalsize)} exceeds the ${String(initial.size)}-byte file`,
        {
          offset: 0,
          field: "totalsize",
          availableBytes: initial.size,
          requiredBytes: totalsize,
        },
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
    const limitations = [...structure.limitations];
    let index = 0;
    for (const image of structure.images) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.assertOpen(signal);
      const hashResult = await this.#verifyHashes(image, signal);
      limitations.push(...hashResult.limitations);
      entries.push({
        path: `images/${image.name}.bin`,
        sourcePath: `/images/${image.name}`,
        kind: "file" as const,
        declaredSize: image.size,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: image.start,
        declaredIntegrity: hashResult.declaredIntegrity,
        unpacked: false,
        limitations: [...image.limitations, ...hashResult.limitations],
        adapterKey: `fit:${String(image.index)}`,
        formatMetadata:
          hashResult.mismatches === 0
            ? image.metadata
            : {
                ...image.metadata,
                hashes_verified: Math.max(
                  0,
                  image.metadata.hashes_verified - hashResult.mismatches,
                ),
              },
      });
    }
    return {
      entries,
      coverage: {
        status: "complete",
        limitations,
      },
      formatMetadata: structure.metadata,
    };
  }

  /** One streamed pass per image feeds every supported digest. */
  async #verifyHashes(
    image: FitImageDeclaration,
    signal?: AbortSignal,
  ): Promise<{
    readonly mismatches: number;
    readonly limitations: readonly string[];
    readonly declaredIntegrity: ArtifactIntegrityClaim | null;
  }> {
    const digests = image.hashes.flatMap((hash) => {
      const digest = createFitDigest(hash.algo);
      return digest === undefined ? [] : [{ hash, digest }];
    });
    if (digests.length === 0)
      return { mismatches: 0, limitations: [], declaredIntegrity: null };
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
    const limitations: string[] = [];
    let mismatches = 0;
    let declaredIntegrity: ArtifactIntegrityClaim | null = null;
    for (const { hash, digest } of digests) {
      const computed = digest.digest();
      if (!computed.equals(hash.value)) {
        const message = `FIT image ${image.name} ${hash.node} ${hash.algo} does not match: declared ${hash.value.toString("hex")}, computed ${computed.toString("hex")}`;
        if (this.#integrity === "fail")
          throw new ArtifactReaderFailure("integrity", message, {
            integrityCheck: "declared-digest",
          });
        mismatches += 1;
        limitations.push(message);
        if (
          declaredIntegrity === null &&
          (hash.algo === "sha256" || hash.algo === "md5")
        ) {
          declaredIntegrity = {
            algorithm: hash.algo,
            digest: hash.value.toString("hex"),
          };
        }
      }
    }
    return { mismatches, limitations, declaredIntegrity };
  }
}

const hashReadCancelled = (reason: unknown): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "FIT read cancelled", {
    cause: reason,
  });
