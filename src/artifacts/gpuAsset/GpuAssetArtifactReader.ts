import type {
  DdsMetadata,
  GlbMetadata,
  Ktx2Metadata,
  KtxMetadata,
} from "../../domain/formatMetadata/gpuAssetMetadata.js";
import type { StableRegularFileDescriptor } from "../../filesystem/RegularFile.js";
import { artifactParseFailure } from "../../resources/index.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { readArtifactFileBytes } from "../ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "../PositionalArtifactReader.js";
import {
  ddsLayout,
  glbLayout,
  ktx2Layout,
  ktxLayout,
  type GpuAssetLayout,
  type GpuAssetRead,
} from "./GpuAssetLayouts.js";

/** Header bytes read before a layout asks for more. */
const HEADER_BYTES = 4096;

type GpuAssetMetadata = DdsMetadata | GlbMetadata | KtxMetadata | Ktx2Metadata;
export type GpuAssetFormat = GpuAssetMetadata["kind"];

const LAYOUTS: {
  readonly [Format in GpuAssetFormat]: (
    header: Buffer,
    fileSize: number,
    read: GpuAssetRead,
  ) =>
    | GpuAssetLayout<Extract<GpuAssetMetadata, { kind: Format }>>
    | Promise<GpuAssetLayout<Extract<GpuAssetMetadata, { kind: Format }>>>;
} = {
  dds: (header, fileSize) => ddsLayout(header, fileSize),
  glb: glbLayout,
  ktx: ktxLayout,
  ktx2: ktx2Layout,
};

const LABELS: Readonly<Record<GpuAssetFormat, string>> = {
  dds: "DDS texture",
  glb: "GLB model",
  ktx: "KTX texture",
  ktx2: "KTX2 texture",
};

/**
 * Declared header facts and regions of a GPU asset container. Payloads are
 * listed as stored byte ranges and never decoded or decompressed.
 */
export class GpuAssetArtifactReader extends PositionalArtifactReader<GpuAssetMetadata> {
  override readonly format: GpuAssetFormat;

  constructor(
    path: string,
    format: GpuAssetFormat,
    admitted?: StableRegularFileDescriptor,
  ) {
    super(path, LABELS[format], admitted);
    this.format = format;
  }

  formatMetadata(): GpuAssetMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<GpuAssetMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const read: GpuAssetRead = (offset, length) =>
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
    let layout: GpuAssetLayout<GpuAssetMetadata>;
    try {
      layout = await LAYOUTS[this.format](header, initial.size, read);
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError)
        throw artifactParseFailure(cause, signal);
      throw cause;
    }
    const entries = layout.regions.map((region): PositionalArtifactEntry => ({
      path: region.path,
      kind: "file",
      declaredSize: region.length,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: region.offset,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: `${this.format}:${region.path}`,
      formatMetadata: {
        kind: "gpu-asset-region",
        role: region.role,
        index: region.index,
      },
    }));
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
