import {
  DEFAULT_ANDROID_DTBO_READER_LIMITS,
  type AndroidDtboReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import {
  ANDROID_DTBO_FORMAT,
  ANDROID_DTBO_HEADER_MIN_SIZE,
  ANDROID_DTBO_LIMITS,
  type AndroidDtboLimitSpec,
  type AndroidDtboParseError,
  parseAndroidDtboEntries,
  parseAndroidDtboHeader,
} from "../domain/firmware/androidDtboFormat.js";
import { hasDevicetreeMagic } from "../domain/firmware/devicetreeHeader.js";
import type {
  AndroidDtboEntryMetadata,
  AndroidDtboMetadata,
} from "../domain/formatMetadata/androidAndSystemMetadata.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  artifactParseFailure,
  artifactReaderLimitFailure,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
  PositionalArtifactReader,
} from "./PositionalArtifactReader.js";

const FDT_MAGIC_PREFIX_BYTES = 4;

type DtboEntry = PositionalArtifactEntry & {
  readonly formatMetadata: AndroidDtboEntryMetadata;
};

const ANDROID_DTBO_LIMIT_BY_NAME: ReadonlyMap<string, AndroidDtboLimitSpec> =
  new Map(Object.values(ANDROID_DTBO_LIMITS).map((spec) => [spec.name, spec]));

function readObservedHexMagic(bytes: Buffer): string {
  const reader = new BinaryReader(bytes, false, ANDROID_DTBO_FORMAT);
  return `0x${reader.u32(0).toString(16).padStart(8, "0")}`;
}

function parseFailure(failure: AndroidDtboParseError): Error {
  const facts = failure.failure;
  if (facts.kind === "limit") {
    const spec = ANDROID_DTBO_LIMIT_BY_NAME.get(facts.limit.name);
    if (spec !== undefined) {
      return artifactReaderLimitFailure(
        spec.parameter,
        facts.limit.maximum,
        spec.unit,
        facts.limit.required,
      );
    }
  }
  const mapped = artifactParseFailure(
    new ParseFailureError(failure.failure, { cause: failure }),
    undefined,
    () => "capacity",
  );
  return mapped instanceof Error ? mapped : failure;
}

function entryLogicalPath(index: number): string {
  return `dtbo-${index}.dtbo`;
}

/** Read an Android DTBO partition table image without unpacking or overlaying it. */
export class AndroidDtboArtifactReader extends PositionalArtifactReader<AndroidDtboMetadata> {
  override readonly format = ANDROID_DTBO_FORMAT;
  readonly #limits: AndroidDtboReaderLimits;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits: AndroidDtboReaderLimits = DEFAULT_ANDROID_DTBO_READER_LIMITS,
  ) {
    super(path, "Android DTBO image", admitted);
    this.#limits = limits;
  }

  formatMetadata(): AndroidDtboMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : { ...metadata };
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<AndroidDtboMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerSliceSize = Math.min(
      initial.size,
      ANDROID_DTBO_HEADER_MIN_SIZE,
    );
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      headerSliceSize,
      initial.size,
      signal,
    );
    this.assertOpen(signal);

    const headerResult = parseAndroidDtboHeader(
      headerBytes,
      initial.size,
      this.#limits,
    );
    if (!headerResult.ok) throw parseFailure(headerResult.error);
    const header = headerResult.value;

    const tableBuffer =
      header.dtEntryCount > 0
        ? await readArtifactFileBytes(
            handle,
            header.dtEntriesOffset,
            header.tableSize,
            initial.size,
            signal,
          )
        : Buffer.alloc(0);
    if (header.dtEntryCount > 0) this.assertOpen(signal);

    const entriesResult = parseAndroidDtboEntries(header, tableBuffer);
    if (!entriesResult.ok) throw parseFailure(entriesResult.error);
    const parsedTable = entriesResult.value;

    const entries: DtboEntry[] = [];
    const childLimitations: string[] = [];

    for (const row of parsedTable.entries) {
      this.assertOpen(signal);
      const magicProbeLength = Math.min(row.dtSize, FDT_MAGIC_PREFIX_BYTES);
      const magicBytes = await readArtifactFileBytes(
        handle,
        row.dtOffset,
        magicProbeLength,
        initial.size,
        signal,
      );

      const isCompressed =
        row.compression !== null && row.compression !== "none";
      const hasFdtMagic = !isCompressed && hasDevicetreeMagic(magicBytes);
      const entryLimitations: string[] = [];

      if (isCompressed) {
        const message =
          row.compression === "unknown"
            ? `DTBO entry ${row.index} declares unknown compression code ${(row.flags ?? 0) & 0x0f} (flags 0x${(row.flags ?? 0).toString(16).padStart(8, "0")}); compressed DTBO payloads are not decompressed and inner FDT magic was not verified.`
            : `DTBO entry ${row.index} declares ${row.compression} compression (flags 0x${(row.flags ?? 0).toString(16).padStart(8, "0")}); compressed DTBO payloads are not decompressed and inner FDT magic was not verified.`;
        entryLimitations.push(message);
        childLimitations.push(message);
      } else if (!hasFdtMagic) {
        const message =
          row.dtSize < FDT_MAGIC_PREFIX_BYTES
            ? `DTBO entry ${row.index} (${row.dtSize} bytes) is shorter than the 4-byte FDT magic 0xd00dfeed.`
            : `DTBO entry ${row.index} does not start with FDT magic 0xd00dfeed (observed ${readObservedHexMagic(magicBytes)}).`;
        entryLimitations.push(message);
        childLimitations.push(message);
      }

      const entryPath = entryLogicalPath(row.index);
      const formatMetadata: AndroidDtboEntryMetadata = {
        kind: "android-dtbo-entry",
        index: row.index,
        dt_size: row.dtSize,
        dt_offset: row.dtOffset,
        id: row.id,
        rev: row.rev,
        flags: row.flags,
        compression: row.compression,
        custom: [...row.custom],
        fdt_magic_valid: hasFdtMagic,
      };

      entries.push({
        path: entryPath,
        kind: "file",
        declaredSize: row.dtSize,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: row.dtOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: entryLimitations,
        adapterKey: `android-dtbo:${entryPath}`,
        formatMetadata,
      });
    }

    const rootMetadata: AndroidDtboMetadata = {
      kind: "android-dtbo",
      magic: header.magic,
      total_size: header.totalSize,
      header_size: header.headerSize,
      dt_entry_size: header.dtEntrySize,
      dt_entry_count: header.dtEntryCount,
      dt_entries_offset: header.dtEntriesOffset,
      page_size: header.pageSize,
      version: header.version,
      emitted_entry_count: entries.length,
    };

    return {
      entries,
      formatMetadata: rootMetadata,
      coverage: {
        status: "complete",
        limitations: [
          ...header.limitations,
          ...parsedTable.limitations,
          ...childLimitations,
        ],
      },
    };
  }
}
