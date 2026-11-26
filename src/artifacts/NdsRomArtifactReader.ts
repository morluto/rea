import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import {
  NDS_DIRECTORY_DEPTH_LIMIT,
  NDS_HEADER_BYTES,
  NDS_MAX_FAT_BYTES,
  NDS_MAX_FNT_BYTES,
  NDS_MAX_OVERLAY_TABLE_BYTES,
  NDS_PATH_BYTES_LIMIT,
  ndsTableReadRange,
  parseNdsHeader,
  parseNdsLayout,
  type NdsLayoutLimits,
  type NdsMetadata,
} from "../domain/ndsRom.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
  artifactReaderLimitFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

/**
 * Nintendo DS cartridge ROM: the ARM9 and ARM7 binaries, overlay files and
 * the NitroROM filesystem listed as stored byte ranges. Nothing is decrypted,
 * decompressed or executed.
 */
export class NdsRomArtifactReader extends PositionalArtifactReader<NdsMetadata> {
  override readonly format = "nds" as const;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly expandedBytes?: number,
    private readonly layoutLimits?: NdsLayoutLimits,
  ) {
    super(path, "Nintendo DS ROM", admitted);
  }

  formatMetadata(): NdsMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<NdsMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const read = (offset: number, length: number): Promise<Buffer> =>
      readArtifactFileBytes(
        this.format,
        handle,
        offset,
        length,
        initial.size,
        signal,
      );
    let layout: ReturnType<typeof parseNdsLayout>;
    try {
      const header = parseNdsHeader(
        await read(0, Math.min(NDS_HEADER_BYTES, initial.size)),
      );
      const tableLimitations: string[] = [];
      const table = async (
        name: string,
        declared: { readonly offset: number; readonly length: number },
        ceiling: number,
      ): Promise<Buffer | undefined> => {
        const range = ndsTableReadRange(name, declared, initial.size, ceiling);
        tableLimitations.push(...range.limitations);
        if (range.offset === undefined) return undefined;
        return read(range.offset, range.length);
      };
      const { metadata } = header;
      const tables = {
        fat: await table("FAT", metadata.fat, NDS_MAX_FAT_BYTES),
        fnt: await table("FNT", metadata.fnt, NDS_MAX_FNT_BYTES),
        arm9Overlays: await table(
          "ARM9 overlay table",
          metadata.arm9_overlay_table,
          NDS_MAX_OVERLAY_TABLE_BYTES,
        ),
        arm7Overlays: await table(
          "ARM7 overlay table",
          metadata.arm7_overlay_table,
          NDS_MAX_OVERLAY_TABLE_BYTES,
        ),
      };
      this.assertOpen(signal);
      layout = parseNdsLayout(
        header,
        tables,
        initial.size,
        tableLimitations,
        this.layoutLimits,
      );
    } catch (cause: unknown) {
      if (cause instanceof ParseFailureError) {
        if (cause.failure.kind === "limit") {
          const { name, maximum } = cause.failure.limit;
          if (name === NDS_PATH_BYTES_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Nintendo DS ROM expanded path allowance",
                kind: "parser",
                limit: maximum,
                unit: "bytes",
              },
              cause.message,
              "memory",
              { cause },
            );
          if (name === NDS_DIRECTORY_DEPTH_LIMIT)
            throw artifactFixedLimitFailure(
              {
                name: "The Nintendo DS ROM directory depth allowance",
                kind: "parser",
                limit: maximum,
                unit: "levels",
              },
              cause.message,
              "capacity",
              { cause },
            );
        }
        throw artifactParseFailure(cause, signal);
      }
      throw cause;
    }
    // Distinct FAT IDs may share one carrier range; every listed member is
    // hashed and extractable separately, so admit aggregate readable bytes
    // before building entries or reading member content.
    const expansionBudget =
      this.expandedBytes ?? artifactExpansionBudgetBytes(initial.size);
    let declaredBytes = 0n;
    for (const region of layout.regions) declaredBytes += BigInt(region.length);
    if (declaredBytes > BigInt(expansionBudget))
      throw artifactReaderLimitFailure(
        "artifact_limits.expanded_bytes",
        expansionBudget,
        "bytes",
        declaredBytes,
        "memory",
      );
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
      adapterKey: `nds:${region.path}`,
      formatMetadata: region.metadata,
    }));
    return {
      entries,
      coverage: {
        status: layout.complete ? "complete" : "unknown",
        limitations: [...layout.limitations],
      },
      formatMetadata: layout.metadata,
    };
  }
}
