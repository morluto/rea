import {
  DEFAULT_ANDROID_DTBO_READER_LIMITS,
  type AndroidDtboReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
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
  readonly #expandedBytes: number | undefined;

  /** `expandedBytes` is `artifact_limits.expanded_bytes`. */
  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    limits: AndroidDtboReaderLimits = DEFAULT_ANDROID_DTBO_READER_LIMITS,
    expandedBytes?: number,
  ) {
    super(path, "Android DTBO image", admitted);
    this.#limits = limits;
    this.#expandedBytes = expandedBytes;
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
      ANDROID_DTBO_FORMAT,
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
            ANDROID_DTBO_FORMAT,
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

    // Shared payloads are valid, but every row is hashed and can be copied
    // separately, so admit the whole table's declared bytes before reading
    // any payload: 4096 rows naming one large payload multiply the work.
    const expansionBudget =
      this.#expandedBytes ?? artifactExpansionBudgetBytes(header.totalSize);
    const declaredBytes = parsedTable.entries.reduce(
      (total, row) => total + row.dtSize,
      0,
    );
    if (declaredBytes > expansionBudget)
      throw artifactReaderLimitFailure(
        "artifact_limits.expanded_bytes",
        expansionBudget,
        "bytes",
        declaredBytes,
        "memory",
      );

    const entries: DtboEntry[] = [];
    const childLimitations: string[] = [];

    for (const row of parsedTable.entries) {
      this.assertOpen(signal);
      const magicProbeLength = Math.min(row.dtSize, FDT_MAGIC_PREFIX_BYTES);
      const magicBytes = await readArtifactFileBytes(
        ANDROID_DTBO_FORMAT,
        handle,
        row.dtOffset,
        magicProbeLength,
        initial.size,
        signal,
      );

      const isCompressed =
        row.compression !== null && row.compression !== "none";
      // A compressed payload's inner magic is unknown, not absent.
      const hasFdtMagic = isCompressed ? null : hasDevicetreeMagic(magicBytes);
      const entryLimitations: string[] = [];

      if (isCompressed) {
        const message =
          row.compression === "unknown"
            ? `DTBO entry ${row.index} declares unknown compression code ${(row.flags ?? 0) & 0x0f} (flags 0x${(row.flags ?? 0).toString(16).padStart(8, "0")}); compressed DTBO payloads are not decompressed and inner FDT magic was not verified.`
            : `DTBO entry ${row.index} declares ${row.compression} compression (flags 0x${(row.flags ?? 0).toString(16).padStart(8, "0")}); compressed DTBO payloads are not decompressed and inner FDT magic was not verified.`;
        entryLimitations.push(message);
        childLimitations.push(message);
      } else if (hasFdtMagic === false) {
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

    const gaps = parsedTable.unaccountedRanges.map(
      ([start, end]) =>
        `${end - start} bytes at [${start}, ${end}) inside total_size are not claimed by the header, entry table or any entry and may hold unlisted data.`,
    );
    return {
      entries,
      formatMetadata: rootMetadata,
      coverage: {
        status: gaps.length === 0 ? "complete" : "unknown",
        limitations: [
          ...header.limitations,
          ...parsedTable.limitations,
          ...gaps,
          ...childLimitations,
        ],
      },
    };
  }
}
