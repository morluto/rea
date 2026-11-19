import { BinaryReader } from "../domain/binaryContainer.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { Buffer } from "node:buffer";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type {
  UefiFfsFileRecord,
  UefiIntegrityRecord,
  UefiSectionRecord,
  UefiUnknownRegion,
  UefiVolumeRecord,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import {
  FFS_TYPE_NAME_BY_CODE,
  FV_HEADER_LAYOUT,
  SECTION_TYPE_NAME_BY_CODE,
} from "./UefiCodeTables.js";
import {
  firstFfsFileLocal,
  nextFfsFileLocal,
  isErasedFfsHeader,
  parseFfsFileHeader,
  verifyFfsFileChecksum,
  type FfsFileHeader,
} from "./FfsFile.js";
import {
  AMD_ZLIB_HEADER_LENGTH,
  peelAmiZlibPayload,
  sectionPayloadRegion,
  walkSections,
} from "./FfsSections.js";
import {
  scanFirmwareVolumes,
  type FirmwareVolumeHeader,
} from "./FirmwareVolume.js";
import {
  absoluteOffset,
  imageRegion,
  isWindowUniform,
  localOffsetOf,
  sliceRegion,
  type ScanRegion,
} from "./UefiBytes.js";

/** Successful external LZMA decode handed back to the scan. */
interface UefiLzmaDecodeOutcome {
  readonly bytes: Buffer;
  readonly decoderVersion: string;
}

export type UefiDecodeFormat = "lzma" | "lzmaf86" | "zlib";

/** One decodable stream submitted to the injected decode lane. */
interface UefiLzmaDecodeRequest {
  readonly payload: Buffer;
  readonly logicalPath: string;
  readonly format: UefiDecodeFormat;
  readonly maxOutputBytes: number;
  /** Physical image range of the compressed stream, when inside the image. */
  readonly physicalRange: {
    readonly offset: number;
    readonly length: number;
  } | null;
}

/**
 * The decoder reports recoverable format and output failures as result data.
 * The scan retains the carrier and diagnostic for extraction.
 */
export type UefiDecodeResult =
  | { readonly ok: true; readonly outcome: UefiLzmaDecodeOutcome }
  | { readonly ok: false; readonly message: string };

export type UefiLzmaDecoder = (
  request: UefiLzmaDecodeRequest,
) => Promise<UefiDecodeResult>;

interface UefiScanLimits {
  readonly maxDepth: number;
  readonly maxVolumes: number;
  readonly maxFiles: number;
}

interface PspEntryRecord {
  readonly type: number;
  readonly declaredLocation: number | null;
  readonly declaredLocationRaw: string;
  readonly addressMode: number;
  readonly declaredSize: number;
  readonly imageOffset: number | null;
  readonly sha256: string | null;
  readonly locationBasis: "declared-unverified";
}

interface PspTableRecord {
  readonly offset: number;
  readonly length: number;
  readonly tableMagic: "$PSP" | "$PL2";
  readonly totalEntries: number;
  readonly entries: readonly PspEntryRecord[];
  readonly entryStrideBasis: "psp-16";
}

interface PspCandidateRecord {
  readonly offset: number;
  readonly magic: string;
  readonly reason: string;
}

/** Payload bytes and the exact window in the stream that supplied them. */
export interface UefiPayload {
  readonly bytes: Buffer;
  readonly sourceStream: string | null;
  readonly range: { readonly offset: number; readonly length: number };
}

interface UefiDecodedStream {
  readonly bytes: Buffer;
  readonly format: UefiDecodeFormat;
  readonly decoderVersion: string;
  readonly carrier: UefiPayload;
}

export interface UefiImageScanSummary {
  readonly inputSize: number;
  readonly payloads: ReadonlyMap<string, UefiPayload>;
  readonly decodedStreams: ReadonlyMap<string, UefiDecodedStream>;
  readonly decodeGaps: ReadonlyMap<string, string>;
  readonly volumes: readonly UefiVolumeRecord[];
  readonly unknownRegions: readonly UefiUnknownRegion[];
  readonly integrity: readonly UefiIntegrityRecord[];
  readonly pspTables: readonly PspTableRecord[];
  readonly pspCandidates: readonly PspCandidateRecord[];
  readonly limitations: readonly string[];
  readonly budgetExhausted: boolean;
  readonly truncationObserved: boolean;
}

type VolumeBuilder = {
  -readonly [K in keyof UefiVolumeRecord]: UefiVolumeRecord[K];
};
type FileBuilder = {
  -readonly [K in keyof UefiFfsFileRecord]: UefiFfsFileRecord[K];
};
type SectionBuilder = {
  -readonly [K in keyof UefiSectionRecord]: UefiSectionRecord[K];
};

const hex = (value: number): string => `0x${value.toString(16)}`;

/** Table names mirror the contract enum; unlisted codes report "unknown". */
const ffsTypeNameFor = (code: number): UefiFfsFileRecord["type_name"] => {
  const name = FFS_TYPE_NAME_BY_CODE[code] as string | undefined;
  return (name ?? "unknown") as UefiFfsFileRecord["type_name"];
};

const PSP_MAGICS = ["$PSP", "$PL2"] as const;

/**
 * Scan one full firmware image: volume discovery, FFS and section mapping,
 * explicit recursion into nested volumes and externally decoded LZMA
 * payloads, conservative PSP probing, and classification of leftover bytes.
 * The decode lane is injected so the scan stays testable without a child
 * process; the provider supplies the bounded worker.
 */
export const scanUefiImage = async (
  image: Buffer,
  limits: UefiScanLimits,
  decodeLzma: UefiLzmaDecoder,
  checkpoint: () => void = () => {},
): Promise<UefiImageScanSummary> => {
  const payloads = new Map<string, UefiPayload>();
  const decodedStreams = new Map<string, UefiDecodedStream>();
  const decodeGaps = new Map<string, string>();
  let decodedBytes = 0;
  let recordsRemaining: number = UEFI_FIRMWARE_LIMITS.scanRecords;
  const reserve = (count = 1): boolean => {
    checkpoint();
    if (count > recordsRemaining) {
      if (recordsRemaining >= 0) {
        limitations.push(
          `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached.`,
        );
        recordsRemaining = -1;
      }
      budgetExhausted = true;
      return false;
    }
    recordsRemaining -= count;
    return true;
  };
  const payloadOf = (
    region: ScanRegion,
    start: number,
    end: number,
  ): UefiPayload => ({
    bytes: region.buffer.subarray(start, end),
    sourceStream: region.sourceStream ?? null,
    range: { offset: absoluteOffset(region, start), length: end - start },
  });
  const volumes: VolumeBuilder[] = [];
  const unknownRegions: UefiUnknownRegion[] = [];
  const integrity: UefiIntegrityRecord[] = [];
  const limitations: string[] = [];
  const pspTables: PspTableRecord[] = [];
  const pspCandidates: PspCandidateRecord[] = [];
  let budgetExhausted = false;
  let truncationObserved = false;
  let filesDiscovered = 0;
  let volumesDiscovered = 0;

  const noteIntegrity = (
    kind: UefiIntegrityRecord["kind"],
    logicalPath: string,
    offset: number,
    length: number,
    detail: string,
    sourceStream: string | null,
  ): void => {
    if (!reserve()) return;
    integrity.push({
      kind,
      logical_path: logicalPath,
      source_stream: sourceStream,
      range: { offset, length },
      detail,
    });
  };

  const noteLimitations = (lines: readonly string[]): void => {
    for (const line of lines) {
      if (limitations.length >= 512 || !reserve()) break;
      limitations.push(line);
    }
  };

  const decodeGap = (path: string, detail: string): null => {
    decodeGaps.set(path, detail);
    noteLimitations([detail]);
    return null;
  };

  const classifyLeftover = (
    region: ScanRegion,
    absoluteStart: number,
    absoluteEnd: number,
    logicalPath: string,
  ): void => {
    const length = absoluteEnd - absoluteStart;
    if (length <= 0 || !reserve()) {
      return;
    }
    const localStart = Math.max(
      region.start,
      Math.min(region.end, localOffsetOf(region, absoluteStart)),
    );
    const localEnd = Math.max(
      localStart,
      Math.min(region.end, localStart + length),
    );
    let classification: UefiUnknownRegion["classification"] = "no-fv-magic";
    let erasure: UefiUnknownRegion["erasure"] = "none";
    if (isWindowUniform(region.buffer, localStart, localEnd, 0xff)) {
      classification = "erased-ff";
      erasure = "0xff";
    } else if (isWindowUniform(region.buffer, localStart, localEnd, 0x00)) {
      classification = "erased-00";
      erasure = "0x00";
    }
    unknownRegions.push({
      source_stream: region.sourceStream ?? null,
      offset: absoluteStart,
      length,
      sha256: sha256Hex(region.buffer.subarray(localStart, localEnd)),
      classification,
      erasure,
    });
    if (classification === "no-fv-magic") {
      noteLimitations([
        `Unparsed region under ${logicalPath} at ${hex(absoluteStart)}, ${length} bytes.`,
      ]);
    }
  };

  const scanVolumesInRegion = async (
    region: ScanRegion,
    depth: number,
    parentOffset: number | null,
    parentLogicalPath: string,
    classifyNoVolumes = true,
  ): Promise<VolumeBuilder[]> => {
    const localRecords: VolumeBuilder[] = [];
    if (depth > limits.maxDepth) {
      budgetExhausted = true;
      noteLimitations([
        `Volume depth limit ${limits.maxDepth} reached under ${parentLogicalPath}.`,
      ]);
      return localRecords;
    }
    const discovered = scanFirmwareVolumes(
      region,
      UEFI_FIRMWARE_LIMITS.scanRecords,
      {
        reserve,
        skipNested: true,
      },
    );
    for (const rejected of discovered.rejected) {
      noteLimitations([
        `_FVH hit under ${parentLogicalPath} at ${hex(rejected.absoluteBase)} not confirmed: ${rejected.reason}.`,
      ]);
      if (classifyNoVolumes && rejected.reason.includes("truncates-region")) {
        truncationObserved = true;
      }
    }

    let mappedThrough = region.origin;
    for (const { header } of discovered.volumes) {
      if (volumesDiscovered >= limits.maxVolumes) {
        budgetExhausted = true;
        noteLimitations([
          `Firmware volume budget ${limits.maxVolumes} reached under ${parentLogicalPath}.`,
        ]);
        break;
      }
      volumesDiscovered += 1;
      classifyLeftover(
        region,
        mappedThrough,
        header.absoluteBase,
        parentLogicalPath,
      );

      const logicalPath = `${parentLogicalPath}/FV@${hex(header.absoluteBase)}`;
      if (!header.checksumValid) {
        noteIntegrity(
          "fv-checksum-mismatch",
          logicalPath,
          header.absoluteBase,
          header.headerLength,
          "Volume header checksum does not sum to zero over HeaderLength bytes.",
          region.sourceStream ?? null,
        );
      }
      const volumeEnd = Math.min(
        header.absoluteBase + header.declaredLength,
        absoluteOffset(region, region.end),
      );
      const observed = sliceRegion(
        region,
        header.absoluteBase,
        volumeEnd - header.absoluteBase,
      );
      const volume: VolumeBuilder = {
        source_stream: region.sourceStream ?? null,
        parent_logical_path: parentOffset === null ? null : parentLogicalPath,
        logical_path: logicalPath,
        offset: header.absoluteBase,
        length: Math.max(1, volumeEnd - header.absoluteBase),
        declared_length: header.declaredLength,
        depth,
        parent_offset: parentOffset,
        sha256: sha256Hex(observed ?? Buffer.alloc(0)),
        file_system_guid: header.fileSystemGuid,
        signature: "_FVH",
        header_length: header.headerLength,
        attributes: header.attributes,
        revision: header.revision,
        ext_header_offset: header.extHeaderOffset,
        block_map: header.blockMap.map((entry) => ({
          num_blocks: entry.numBlocks,
          length: entry.blockLength,
        })),
        ffs_files: [],
      };
      volumes.push(volume);
      await walkFiles(volume, header, depth, region, volumeEnd);
      const lastFile = volume.ffs_files[volume.ffs_files.length - 1];
      const filesMappedThrough =
        lastFile == null
          ? volume.offset + volume.header_length
          : lastFile.offset + lastFile.length;
      classifyLeftover(region, filesMappedThrough, volumeEnd, logicalPath);
      mappedThrough = volumeEnd;
      localRecords.push(volume);
    }
    if (
      !discovered.exhausted &&
      localRecords.length === discovered.volumes.length &&
      (classifyNoVolumes || localRecords.length > 0)
    ) {
      classifyLeftover(
        region,
        mappedThrough,
        absoluteOffset(region, region.end),
        parentLogicalPath,
      );
    }
    return localRecords;
  };

  const walkFiles = async (
    volume: VolumeBuilder,
    header: FirmwareVolumeHeader,
    depth: number,
    parentRegion: ScanRegion,
    volumeEnd: number,
  ): Promise<void> => {
    const volumeLocalEnd = localOffsetOf(parentRegion, volumeEnd);
    const fileAreaStart = Math.min(firstFfsFileLocal(header), volumeLocalEnd);
    const fileArea: ScanRegion = {
      buffer: parentRegion.buffer,
      start: fileAreaStart,
      end: volumeLocalEnd,
      origin: absoluteOffset(parentRegion, fileAreaStart),
      ...(parentRegion.sourceStream === undefined
        ? {}
        : { sourceStream: parentRegion.sourceStream }),
    };
    if (fileArea.end <= fileArea.start) {
      return;
    }
    let cursor = fileArea.start;
    while (cursor + 24 <= fileArea.end) {
      checkpoint();
      if (isErasedFfsHeader(fileArea, cursor, header.erasePolarity)) break;
      if (filesDiscovered >= limits.maxFiles) {
        budgetExhausted = true;
        noteLimitations([
          `FFS file budget ${limits.maxFiles} reached inside ${volume.logical_path}.`,
        ]);
        break;
      }
      if (!reserve()) break;
      const fileHeader = parseFfsFileHeader(
        fileArea,
        cursor,
        header.erasePolarity,
      );
      if (fileHeader == null) {
        truncationObserved = true;
        noteLimitations([
          `FFS header unparseable in ${volume.logical_path} at ${hex(absoluteOffset(parentRegion, cursor))}; file walk ends.`,
        ]);
        break;
      }
      filesDiscovered += 1;
      for (const implausibility of fileHeader.implausibilities) {
        noteLimitations([
          `FFS header implausibility "${implausibility}" at ${hex(fileHeader.absoluteBase)} in ${volume.logical_path}.`,
        ]);
      }
      const logicalPath = `${volume.logical_path}/FFS:${fileHeader.nameGuid ?? "unknown"}@${hex(fileHeader.absoluteBase)}`;
      const observedEnd = Math.min(
        fileHeader.localBase + fileHeader.declaredLength,
        fileArea.end,
      );
      const truncatesArea =
        fileHeader.localBase + fileHeader.declaredLength > fileArea.end;
      const declaredBelowHeader =
        fileHeader.declaredLength < fileHeader.headerLength;
      if (truncatesArea || declaredBelowHeader) truncationObserved = true;
      if (declaredBelowHeader) {
        noteIntegrity(
          "size-truncation",
          logicalPath,
          fileHeader.absoluteBase,
          Math.max(1, fileHeader.headerLength),
          "FFS declared length is smaller than the header itself.",
          fileArea.sourceStream ?? null,
        );
      }
      if (truncatesArea && !declaredBelowHeader) {
        noteIntegrity(
          "size-truncation",
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.declaredLength,
          "FFS file declared length exceeds the volume area; walk ends at the volume boundary.",
          fileArea.sourceStream ?? null,
        );
      }
      if (!fileHeader.headerChecksumValid) {
        noteIntegrity(
          "ffs-header-checksum-mismatch",
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.headerLength,
          "FFS header checksum does not sum to zero with State and File bytes zeroed.",
          fileArea.sourceStream ?? null,
        );
      }
      const checksum = checksumVerdict(fileHeader, fileArea, observedEnd);
      if (checksum === "invalid") {
        noteIntegrity(
          "ffs-file-checksum-mismatch",
          logicalPath,
          fileHeader.absoluteBase,
          Math.max(
            1,
            Math.max(
              0,
              observedEnd - (fileHeader.localBase + fileHeader.headerLength),
            ),
          ),
          "File data checksum differs from the declared IntegrityCheck.File byte.",
          fileArea.sourceStream ?? null,
        );
      }
      const observedBytes =
        sliceRegion(
          parentRegion,
          fileHeader.absoluteBase,
          observedEnd - fileHeader.localBase,
        ) ?? Buffer.alloc(0);

      const sections: SectionBuilder[] = [];
      const bodyStart = fileHeader.localBase + fileHeader.headerLength;
      let uiString: string | null = null;
      if (fileHeader.typeCode !== 0xf0 && !declaredBelowHeader) {
        const sectioned =
          fileHeader.typeCode >= 0x02 && fileHeader.typeCode <= 0x0f;
        if (sectioned) {
          uiString = await walkSectionChain(
            fileArea,
            bodyStart,
            observedEnd,
            logicalPath,
            depth,
            volume.offset,
            sections,
          );
        } else {
          payloads.set(
            logicalPath,
            payloadOf(fileArea, bodyStart, observedEnd),
          );
          if (
            fileHeader.typeCode === 0x01 &&
            observedEnd - bodyStart >= FV_HEADER_LAYOUT.minimumLength
          ) {
            await scanVolumesInRegion(
              subRegion(fileArea, bodyStart, observedEnd),
              depth + 1,
              volume.offset,
              `${logicalPath}/embedded`,
            );
          }
        }
      }

      volume.ffs_files.push({
        source_stream: fileArea.sourceStream ?? null,
        offset: fileHeader.absoluteBase,
        header_length: fileHeader.headerLength,
        length: Math.max(1, observedEnd - fileHeader.localBase),
        declared_length: fileHeader.declaredLength,
        guid: fileHeader.nameGuid ?? "ffffffff-ffff-ffff-ffff-ffffffffffff",
        type_code: fileHeader.typeCode,
        type_name: ffsTypeNameFor(fileHeader.typeCode),
        attributes: fileHeader.attributes,
        alignment: String(fileHeader.dataAlignment) as FileBuilder["alignment"],
        state: fileHeader.rawState,
        state_flags: fileHeader.stateFlags as FileBuilder["state_flags"],
        checksum,
        ui_string: uiString,
        logical_path: logicalPath,
        volume_offset: volume.offset,
        sha256: sha256Hex(observedBytes),
        sections,
      });

      if (truncatesArea) {
        break;
      }
      cursor = nextFfsFileLocal(fileHeader, header.localBase);
    }
  };

  const checksumVerdict = (
    fileHeader: FfsFileHeader,
    region: ScanRegion,
    observedEnd: number,
  ): FileBuilder["checksum"] => {
    if (fileHeader.typeCode === 0xf0) {
      return "pad-file-unchecked";
    }
    if (!fileHeader.fileChecksumRequired) {
      return "unchecked";
    }
    const payloadStart = fileHeader.localBase + fileHeader.headerLength;
    const payloadLength = Math.max(0, observedEnd - payloadStart);
    if (payloadLength === 0) {
      return "unchecked";
    }
    return verifyFfsFileChecksum(
      region.buffer,
      payloadStart,
      payloadLength,
      fileHeader.fileChecksumField,
    )
      ? "valid"
      : "invalid";
  };

  const walkSectionChain = async (
    region: ScanRegion,
    start: number,
    end: number,
    parentLogicalPath: string,
    depth: number,
    volumeOffset: number,
    records: SectionBuilder[],
  ): Promise<string | null> => {
    const walked = walkSections(
      region,
      start,
      end,
      (code) => SECTION_TYPE_NAME_BY_CODE[code] ?? "unknown",
      reserve,
    );
    if (
      !walked.terminated &&
      recordsRemaining >= 0 &&
      !walked.sections.some(
        ({ truncated, malformed }) => truncated || malformed,
      )
    ) {
      truncationObserved = true;
      noteLimitations([
        `Section chain under ${parentLogicalPath} ends with incomplete framing.`,
      ]);
    }
    let uiString: string | null = null;
    for (const [index, draft] of walked.sections.entries()) {
      checkpoint();
      const logicalPath = `${parentLogicalPath}/section[${index}]`;
      const payload =
        draft.payload === null
          ? null
          : payloadOf(region, draft.payload.start, draft.payload.end);
      if (payload !== null) payloads.set(logicalPath, payload);
      const compression = draft.compression;
      const record: SectionBuilder = {
        logical_path: logicalPath,
        parent_logical_path: parentLogicalPath,
        source_stream: region.sourceStream ?? null,
        offset: draft.absoluteBase,
        header_length: draft.headerLength,
        length: draft.observedLength,
        declared_length: draft.declaredLength,
        truncated: draft.truncated,
        malformed: draft.malformed ?? false,
        type_code: draft.typeCode,
        type_name: draft.typeName as SectionBuilder["type_name"],
        sha256: sha256Hex(payload?.bytes ?? Buffer.alloc(0)),
        compression:
          compression.kind === "none"
            ? compression
            : {
                kind: compression.kind,
                guid: compression.guid,
                data_offset: compression.dataOffset,
                attributes: compression.attributes,
              },
        sub_volumes: [],
      };
      records.push(record);
      if (draft.truncated || draft.malformed) {
        truncationObserved = true;
        noteLimitations([
          `Section ${logicalPath} has ${draft.malformed ? "malformed framing" : "a truncated payload"} (declared ${draft.declaredLength}, observed ${draft.observedLength} bytes).`,
        ]);
        continue;
      }
      const payloadRegion = sectionPayloadRegion(region, draft);
      if (payload === null || payloadRegion === null) continue;
      if (draft.typeCode === 0x15) {
        uiString ??= decodeUiString(payload.bytes);
      } else if (draft.typeCode === 0x17) {
        const nested = await scanVolumesInRegion(
          payloadRegion,
          depth + 1,
          volumeOffset,
          logicalPath,
        );
        record.sub_volumes = nested.map((entry) => entry.logical_path);
      } else if (draft.encapsulatesSections) {
        if (depth >= limits.maxDepth) {
          budgetExhausted = true;
          noteLimitations([
            `Section depth limit reached under ${logicalPath}.`,
          ]);
        } else {
          const childUi = await walkSectionChain(
            payloadRegion,
            payloadRegion.start,
            payloadRegion.end,
            logicalPath,
            depth + 1,
            volumeOffset,
            records,
          );
          uiString ??= childUi;
        }
      } else if (
        compression.kind === "lzma-custom" ||
        compression.kind === "lzmaf86" ||
        compression.kind === "ami-zlib"
      ) {
        const decoded = await resolveDecodedSection(
          payload,
          logicalPath,
          depth,
          compression.kind,
        );
        if (decoded === null) continue;
        const decodedRegion: ScanRegion = {
          buffer: decoded.bytes,
          start: 0,
          end: decoded.bytes.length,
          origin: 0,
          sourceStream: logicalPath,
        };
        const nested = await scanVolumesInRegion(
          decodedRegion,
          depth + 1,
          volumeOffset,
          `${logicalPath}/${decoded.format}`,
          false,
        );
        record.sub_volumes = nested.map((entry) => entry.logical_path);
        // Decode can yield a complete FV, a section chain or an opaque blob.
        if (
          nested.length === 0 &&
          !budgetExhausted &&
          isSectionChain(decodedRegion)
        ) {
          const childUi = await walkSectionChain(
            decodedRegion,
            0,
            decoded.bytes.length,
            logicalPath,
            depth + 1,
            volumeOffset,
            records,
          );
          uiString ??= childUi;
        }
      } else if (compression.kind !== "none") {
        noteLimitations([
          `No decoder is available for ${compression.kind} section ${logicalPath}.`,
        ]);
      }
    }
    return uiString;
  };

  const resolveDecodedSection = async (
    payload: UefiPayload,
    logicalPath: string,
    depth: number,
    kind: "lzma-custom" | "lzmaf86" | "ami-zlib",
  ): Promise<UefiDecodedStream | null> => {
    const maxOutputBytes = Math.min(
      UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
      UEFI_FIRMWARE_LIMITS.decodedBytes - decodedBytes,
    );
    if (depth >= limits.maxDepth || maxOutputBytes <= 0) {
      budgetExhausted = true;
      return decodeGap(
        logicalPath,
        `Decode depth or aggregate output limit reached under ${logicalPath}.`,
      );
    }
    const format =
      kind === "ami-zlib" ? "zlib" : kind === "lzmaf86" ? "lzmaf86" : "lzma";
    let carrier = payload;
    if (format === "zlib") {
      const peeled = peelAmiZlibPayload(payload.bytes);
      if (
        peeled === null ||
        peeled.declaredCompressedSize !== peeled.stream.length
      ) {
        return decodeGap(
          logicalPath,
          `Invalid AMD zlib header or stream length at ${logicalPath}; carrier retained.`,
        );
      }
      carrier = {
        bytes: peeled.stream,
        sourceStream: payload.sourceStream,
        range: {
          offset: payload.range.offset + AMD_ZLIB_HEADER_LENGTH,
          length: peeled.stream.length,
        },
      };
    }
    const decodedResult = await decodeLzma({
      payload: carrier.bytes,
      logicalPath,
      format,
      physicalRange: carrier.sourceStream === null ? carrier.range : null,
      maxOutputBytes,
    });
    checkpoint();
    if (!decodedResult.ok) {
      return decodeGap(
        logicalPath,
        `${format} decode failed at ${logicalPath}: ${decodedResult.message}`,
      );
    }
    const outcome = decodedResult.outcome;
    if (outcome.bytes.length > maxOutputBytes) {
      return decodeGap(
        logicalPath,
        `Decoded output exceeded its byte limit at ${logicalPath}.`,
      );
    }
    decodedBytes += outcome.bytes.length;
    const decoded = {
      bytes: outcome.bytes,
      format,
      decoderVersion: outcome.decoderVersion,
      carrier,
    } as const;
    decodedStreams.set(logicalPath, decoded);
    return decoded;
  };

  const imageRegion0 = imageRegion(image, 0, image.length);
  await scanVolumesInRegion(imageRegion0, 0, null, "flash");

  scanPspDirectories(image, pspTables, pspCandidates, reserve);

  return {
    inputSize: image.length,
    payloads,
    decodedStreams,
    decodeGaps,
    volumes,
    unknownRegions,
    integrity,
    pspTables,
    pspCandidates,
    limitations,
    budgetExhausted,
    truncationObserved,
  };
};

const subRegion = (
  region: ScanRegion,
  start: number,
  end: number,
): ScanRegion => ({
  ...region,
  start,
  end,
  origin: absoluteOffset(region, start),
});

/** A recognized first frame distinguishes section streams from opaque decoded bytes. */
const isSectionChain = (region: ScanRegion): boolean => {
  const typeCode = region.buffer[3];
  return (
    typeCode !== undefined && SECTION_TYPE_NAME_BY_CODE[typeCode] !== undefined
  );
};

const decodeUiString = (payload: Buffer): string | null => {
  const payloadReader = new BinaryReader(payload, true, "UEFI UI section");
  const limit = Math.min(payload.length - (payload.length % 2), 1024);
  let end = 0;
  while (end < limit && payloadReader.u16(end) !== 0) end += 2;
  return end === 0 ? null : payload.toString("utf16le", 0, end);
};

const scanPspDirectories = (
  image: Buffer,
  tables: PspTableRecord[],
  candidates: PspCandidateRecord[],
  reserve: (count?: number) => boolean,
): void => {
  const reader = new BinaryReader(image, true, "AMD PSP directory");
  const headerLength = 16;
  const entryLength = 16;
  for (const magic of PSP_MAGICS) {
    let searchFrom = 0;
    while (searchFrom < image.length) {
      const hit = image.indexOf(magic, searchFrom, "ascii");
      if (hit < 0 || !reserve()) break;
      searchFrom = hit + magic.length;
      const totalEntries =
        hit + headerLength <= image.length ? reader.u32(hit + 8) : 0;
      const tableLength = headerLength + totalEntries * entryLength;
      if (
        totalEntries === 0 ||
        totalEntries > 255 ||
        hit + tableLength > image.length
      ) {
        candidates.push({
          offset: hit,
          magic,
          reason: "implausible-entry-count",
        });
        continue;
      }
      if (!reserve(totalEntries)) return;
      const entries: PspEntryRecord[] = [];
      for (let index = 0; index < totalEntries; index += 1) {
        const start = hit + headerLength + index * entryLength;
        const raw = reader.word(start + 8, 64);
        const location = raw & ((1n << 62n) - 1n);
        entries.push({
          type: reader.u8(start),
          declaredLocation:
            location <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(location)
              : null,
          declaredLocationRaw: `0x${raw.toString(16).padStart(16, "0")}`,
          addressMode: Number(raw >> 62n),
          declaredSize: reader.u32(start + 4),
          imageOffset: null,
          sha256: null,
          locationBasis: "declared-unverified",
        });
      }
      tables.push({
        offset: hit,
        length: tableLength,
        tableMagic: magic,
        totalEntries,
        entries,
        entryStrideBasis: "psp-16",
      });
    }
  }
};
