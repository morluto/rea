import { crc32 } from "node:zlib";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";

import type {
  UImageEntryMetadata,
  UImageMetadata,
} from "../domain/formatMetadata/firmwareMetadata.js";
import type { ArtifactIntegrityPolicyName } from "../domain/artifactIntegrityPolicy.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  hasUImageSizeTable,
  parseMultiImageTable,
  parseUImageHeaderFields,
  UIMAGE_HEADER_SIZE,
  UIMAGE_MULTI_TABLE_WINDOW,
  type UImageHeaderFields,
  type UImageParseError,
  type UImageSubImage,
} from "../domain/uimageFormat.js";

const PAYLOAD_PATH = "payload.bin";
const READ_CHUNK_BYTES = 64 * 1024;
type UImageEntry = PositionalArtifactEntry & {
  readonly formatMetadata: UImageEntryMetadata;
};

/** Read a U-Boot legacy uImage without running, decompressing, or altering it. */
export class UImageArtifactReader extends PositionalArtifactReader<UImageMetadata> {
  override readonly format = "uimage" as const;
  readonly #integrity: ArtifactIntegrityPolicyName;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    integrity: ArtifactIntegrityPolicyName = "fail",
  ) {
    super(path, "uImage", admitted, "U-Boot uImage");
    this.#integrity = integrity;
  }

  formatMetadata(): UImageMetadata | undefined {
    const header = this.preparedFormatMetadata;
    return header === undefined ? undefined : { ...header };
  }

  protected override entryEndedEarly(
    entry: PositionalArtifactEntry,
  ): ArtifactReaderFailure {
    return formatFailure(`member ended early: ${entry.path}`);
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<UImageMetadata>> {
    const { handle, initial } = await this.verifyCarrier(signal);
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, UIMAGE_HEADER_SIZE),
      initial.size,
      signal,
    );
    const fields = parseUImageHeaderFields(headerBytes);
    if (!fields.ok) throw parseFailure(fields.error);
    const header = fields.value;
    if (initial.size < UIMAGE_HEADER_SIZE + header.payloadSize)
      throw formatFailure(
        `uImage payload is truncated: header declares ${header.payloadSize} payload bytes but only ${initial.size - UIMAGE_HEADER_SIZE} follow the header`,
      );
    // Admit the bounded size table first, then include those same bytes in the
    // native CRC stream. No payload byte needs to be read twice for verification.
    let dataCrc32 = 0;
    let read = 0;
    let subImages: readonly UImageSubImage[] = [];
    let sizeTableLimitation: string | undefined;
    if (hasUImageSizeTable(header.type)) {
      const tablePrefix = await readArtifactFileBytes(
        handle,
        UIMAGE_HEADER_SIZE,
        Math.min(header.payloadSize, UIMAGE_MULTI_TABLE_WINDOW),
        initial.size,
        signal,
      );
      const parsed = parseMultiImageTable(tablePrefix, header.payloadSize);
      if (parsed.ok) {
        subImages = parsed.value;
      } else if (
        this.#integrity === "fail" ||
        parsed.error._tag === "UImageCapacityFailure"
      ) {
        throw parseFailure(parsed.error);
      } else {
        sizeTableLimitation = `Multi-image/script size table could not be parsed (${parsed.error.message}); only the full stored payload.bin is exposed.`;
      }
      dataCrc32 = crc32(tablePrefix);
      read = tablePrefix.length;
    }
    while (read < header.payloadSize) {
      this.assertOpen(signal);
      const chunk = await readArtifactFileBytes(
        handle,
        UIMAGE_HEADER_SIZE + read,
        Math.min(READ_CHUNK_BYTES, header.payloadSize - read),
        initial.size,
        signal,
      );
      dataCrc32 = crc32(chunk, dataCrc32);
      read += chunk.length;
    }
    const crcVerified = dataCrc32 === header.dataCrc32;
    const entries: UImageEntry[] = [
      entryFor("payload", 0, {
        byteOffset: UIMAGE_HEADER_SIZE,
        declaredSize: header.payloadSize,
      }),
      ...subImages.map((sub) => entryFor("sub-image", sub.index, sub)),
    ];
    const limitations: string[] = [];
    if (sizeTableLimitation !== undefined) {
      limitations.push(sizeTableLimitation);
    } else if (hasUImageSizeTable(header.type)) {
      limitations.push(
        "Multi-image sub-images are split from the stored size table; the payload entry retains the full stored bytes.",
      );
    }
    return {
      entries,
      coverage: {
        status: sizeTableLimitation === undefined ? "complete" : "unknown",
        limitations,
      },
      formatMetadata: toMetadata(header, subImages.length, crcVerified),
      containerIntegrity: {
        algorithm: "crc32",
        declared_crc32: crcHex(header.dataCrc32),
        observed_crc32: crcHex(dataCrc32),
      },
    };
  }
}

const formatFailure = (
  detail: string,
  options?: ErrorOptions,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `uImage is malformed: ${detail}`,
    options,
  );

const parseFailure = (failure: UImageParseError): ArtifactReaderFailure =>
  failure._tag === "UImageCapacityFailure"
    ? new ArtifactReaderFailure("limit", failure.message, {
        boundary: "capacity",
        cause: failure,
      })
    : formatFailure(failure.message, { cause: failure });

const entryFor = (
  role: "payload" | "sub-image",
  index: number,
  range: Pick<UImageSubImage, "byteOffset" | "declaredSize">,
): UImageEntry => {
  const payload = role === "payload";
  const path = payload ? PAYLOAD_PATH : `image-${String(index)}.bin`;
  const adapterKey = payload
    ? "uimage:payload"
    : `uimage:image-${String(index)}`;
  return {
    path,
    kind: "file",
    declaredSize: range.declaredSize,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: range.byteOffset,
    declaredIntegrity: null,
    unpacked: false,
    limitations: [],
    adapterKey,
    formatMetadata: { kind: "uimage-entry", role, index },
    sourcePath: path,
  };
};

const crcHex = (value: number): string =>
  (value >>> 0).toString(16).padStart(8, "0");

const toMetadata = (
  facts: UImageHeaderFields,
  subImageCount: number,
  crcVerified: boolean,
): UImageMetadata => ({
  kind: "uimage",
  magic: facts.magic,
  timestamp: facts.timestamp,
  timestamp_iso: facts.timestampIso,
  payload_size: facts.payloadSize,
  load_address: facts.loadAddress,
  entry_point: facts.entryPoint,
  header_crc32: facts.headerCrc32,
  data_crc32: facts.dataCrc32,
  crc_verified: crcVerified,
  os: facts.os,
  os_name: facts.osName,
  arch: facts.arch,
  arch_name: facts.archName,
  type: facts.type,
  type_name: facts.typeName,
  compression: facts.compression,
  compression_name: facts.compressionName,
  name: facts.name,
  name_bytes_hex: facts.nameBytesHex,
  sub_image_count: subImageCount,
});
