import type {
  Bink2Metadata,
  OggOpusMetadata,
  RiffXma2Metadata,
  VulkanPipelineCacheMetadata,
} from "../../domain/formatMetadata/mediaAssetMetadata.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import { artifactParseFailure } from "../../resources/index.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { readArtifactFileBytes } from "../ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  positionalRegionEntry,
  type PositionalArtifactEntries,
} from "../PositionalArtifactReader.js";
import {
  DEFAULT_MEDIA_ASSET_READER_LIMITS,
  type MediaAssetReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import {
  admitMediaAssetRegions,
  bink2Layout,
  oggOpusLayout,
  riffXma2Layout,
  vulkanPipelineCacheLayout,
  type MediaAssetLayout,
  type MediaAssetRead,
} from "./MediaAssetLayouts.js";

/** Header bytes read before a layout asks for more. */
const HEADER_BYTES = 4096;

type MediaAssetMetadata =
  | OggOpusMetadata
  | RiffXma2Metadata
  | Bink2Metadata
  | VulkanPipelineCacheMetadata;
export type MediaAssetFormat = MediaAssetMetadata["kind"];

const LAYOUTS: {
  readonly [Format in MediaAssetFormat]: (
    header: Buffer,
    fileSize: number,
    read: MediaAssetRead,
    limits: MediaAssetReaderLimits,
  ) =>
    | MediaAssetLayout<Extract<MediaAssetMetadata, { kind: Format }>>
    | Promise<MediaAssetLayout<Extract<MediaAssetMetadata, { kind: Format }>>>;
} = {
  "ogg-opus": oggOpusLayout,
  "riff-xma2": riffXma2Layout,
  bink2: (header, fileSize) => bink2Layout(header, fileSize),
  "vulkan-pipeline-cache": (header, fileSize) =>
    vulkanPipelineCacheLayout(header, fileSize),
};

const LABELS: Readonly<Record<MediaAssetFormat, string>> = {
  "ogg-opus": "Ogg Opus audio",
  "riff-xma2": "RIFF WAVE XMA2 audio",
  bink2: "Bink 2 video",
  "vulkan-pipeline-cache": "Vulkan pipeline cache",
};

/**
 * Declared header facts and regions of a media asset container. Payloads are
 * listed as stored byte ranges and never decoded.
 */
export class MediaAssetArtifactReader extends PositionalArtifactReader<MediaAssetMetadata> {
  override readonly format: MediaAssetFormat;

  readonly #limits: MediaAssetReaderLimits;

  constructor(
    path: string,
    format: MediaAssetFormat,
    admitted?: StableRegularFileDescriptor,
    limits: MediaAssetReaderLimits = DEFAULT_MEDIA_ASSET_READER_LIMITS,
  ) {
    super(path, LABELS[format], admitted);
    this.format = format;
    this.#limits = limits;
  }

  formatMetadata(): MediaAssetMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<MediaAssetMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const read: MediaAssetRead = (offset, length) =>
      offset >= initial.size
        ? Promise.resolve(Buffer.alloc(0))
        : readArtifactFileBytes(
            this.format,
            handle,
            offset,
            Math.min(length, initial.size - offset),
            initial.size,
            signal,
          );
    const header = await read(0, HEADER_BYTES);
    let layout: MediaAssetLayout<MediaAssetMetadata>;
    try {
      layout = await LAYOUTS[this.format](
        header,
        initial.size,
        read,
        this.#limits,
      );
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError)
        throw artifactParseFailure(cause, signal);
      throw cause;
    }
    // Every listed region, including the trailing audio and fixed-layout
    // regions, counts against the same admission as the walks.
    admitMediaAssetRegions(
      layout.regions.length,
      this.#limits,
      layout.regions.length,
    );
    const entries = layout.regions.map((region) =>
      positionalRegionEntry(region, this.format, {
        kind: "media-asset-region",
        role: region.role,
        index: region.index,
      }),
    );
    return {
      entries,
      coverage: {
        status:
          layout.metadata.extent_check === "consistent" &&
          layout.regionsExamined === "complete"
            ? "complete"
            : "unknown",
        limitations: [...layout.limitations],
      },
      formatMetadata: layout.metadata,
    };
  }
}
