import {
  scanPspDirectories,
  type PspTableRecord,
  type PspCandidateRecord,
} from "./UefiPspDirectory.js";
import { Budget } from "../domain/budget.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { Buffer } from "node:buffer";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type {
  UefiExtractResult,
  UefiFfsFileRecord,
  UefiIntegrityRecord,
  UefiSectionRecord,
  UefiUnknownRegion,
  UefiVolumeRecord,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import {
  FFS_HEADER_LAYOUT,
  FFS_TYPE_NAME_BY_CODE,
  FV_HEADER_LAYOUT,
  SECTION_TYPE_NAME_BY_CODE,
} from "./UefiCodeTables.js";
import type { UefiDecodeFailureReason } from "./UefiLzmaProtocol.js";
import {
  checkFfsFileIntegrity,
  readFfsHeader,
  type FfsPaddingRange,
} from "./FfsFile.js";
import {
  AMD_ZLIB_HEADER_LENGTH,
  peelAmiZlibPayload,
  startsWithSectionFrame,
  walkSections,
  type UefiDecodeFormat,
} from "./FfsSections.js";
import {
  inspectFirmwareVolumeExtension,
  parseFirmwareVolumeHeader,
  scanFirmwareVolumes,
  type FirmwareVolumeHeader,
  unsupportedVolumeBodyReason,
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
  readonly consumedBytes: number;
}

/** One decodable stream submitted to the injected decode lane. */
interface UefiLzmaDecodeRequest {
  readonly payload: Buffer;
  readonly format: UefiDecodeFormat;
  readonly maxOutputBytes: number;
}

/**
 * The decoder reports recoverable format and output failures as result data.
 * The scan retains the carrier and diagnostic for extraction.
 */
export type UefiDecodeResult =
  | { readonly ok: true; readonly outcome: UefiLzmaDecodeOutcome }
  | {
      readonly ok: false;
      readonly reason: UefiDecodeFailureReason;
      readonly message: string;
    };

export type UefiLzmaDecoder = (
  request: UefiLzmaDecodeRequest,
) => Promise<UefiDecodeResult>;

interface UefiScanLimits {
  readonly maxDepth: number;
  readonly maxVolumes: number;
  readonly maxFiles: number;
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

type ScanOmission = UefiExtractResult["extraction_gaps"][number];
export interface UefiImageScanSummary {
  readonly inputSize: number;
  readonly payloads: ReadonlyMap<string, UefiPayload>;
  readonly decodedStreams: ReadonlyMap<string, UefiDecodedStream>;
  readonly compressedCarriers: ReadonlyMap<string, UefiPayload>;
  readonly volumes: readonly UefiVolumeRecord[];
  readonly unknownRegions: readonly UefiUnknownRegion[];
  readonly omissions: readonly ScanOmission[];
  readonly integrity: readonly UefiIntegrityRecord[];
  readonly pspTables: readonly PspTableRecord[];
  readonly pspCandidates: readonly PspCandidateRecord[];
  readonly limitations: readonly string[];
  readonly coverage: "complete" | "partial";
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
  const compressedCarriers = new Map<string, UefiPayload>();
  let decodedBytes = 0;
  const records = new Budget(UEFI_FIRMWARE_LIMITS.scanRecords);
  let structuralLimitReached = false;
  const reserve = (count = 1): boolean => {
    checkpoint();
    if (structuralLimitReached) return false;
    if (records.tryCharge(count)) return true;
    structuralLimitReached = true;
    limitations.push(
      `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached.`,
    );
    return false;
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
  const omissions: ScanOmission[] = [];
  const integrity: UefiIntegrityRecord[] = [];
  const limitations: string[] = [];
  let incompleteFraming = false;
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
      if (limitations.length >= 512) break;
      limitations.push(line);
    }
  };

  const recordOmission = (omission: ScanOmission): void => {
    omissions.push(omission);
    if (omission.kind !== "pad-file") noteLimitations([omission.detail]);
  };

  const noteOmission = (
    kind: ScanOmission["kind"],
    region: ScanRegion,
    logicalPath: string,
    start: number,
    end: number,
    detail: string,
  ): void => {
    if (start >= end) return;
    recordOmission({
      kind,
      logical_path: logicalPath,
      source_stream: region.sourceStream ?? null,
      range: { offset: start, length: end - start },
      detail,
    });
  };

  const noteCarrierGap = (
    path: string,
    payload: UefiPayload,
    kind: ScanOmission["kind"],
    detail: string,
  ): null => {
    if (payload.bytes.length > 0) compressedCarriers.set(path, payload);
    recordOmission({
      kind,
      logical_path: path,
      source_stream: payload.sourceStream,
      range: payload.range.length > 0 ? payload.range : null,
      detail,
    });
    return null;
  };

  const noteUnparsedRange = (
    region: ScanRegion,
    absoluteStart: number,
    absoluteEnd: number,
    logicalPath: string,
    known?: {
      detail: string;
      classification?: UefiUnknownRegion["classification"];
      nonErased?: true;
    },
  ): void => {
    const length = absoluteEnd - absoluteStart;
    if (length <= 0) return;
    if (!reserve()) {
      noteOmission(
        "size-truncated",
        region,
        logicalPath,
        absoluteStart,
        absoluteEnd,
        `Structural record limit reached before classifying bytes under ${logicalPath}.`,
      );
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
    if (
      !known?.nonErased &&
      isWindowUniform(region.buffer, localStart, localEnd, 0xff)
    ) {
      classification = "erased-ff";
      erasure = "0xff";
    } else if (
      !known?.nonErased &&
      isWindowUniform(region.buffer, localStart, localEnd, 0x00)
    ) {
      classification = "erased-00";
      erasure = "0x00";
    }
    unknownRegions.push({
      source_stream: region.sourceStream ?? null,
      offset: absoluteStart,
      length,
      sha256: sha256Hex(region.buffer.subarray(localStart, localEnd)),
      classification: known?.classification ?? classification,
      erasure,
    });
    if (known !== undefined || erasure === "none") {
      noteOmission(
        "unparsed-region",
        region,
        logicalPath,
        absoluteStart,
        absoluteEnd,
        known?.detail ??
          `Unparsed region under ${logicalPath} at ${hex(absoluteStart)}, ${length} bytes.`,
      );
    }
  };

  const scanVolumesInRegion = async (
    region: ScanRegion,
    depth: number,
    parentOffset: number | null,
    parentLogicalPath: string,
    mode:
      | "volume-region"
      | "embedded-probe"
      | "fv-image-section" = "volume-region",
  ): Promise<{
    volumes: VolumeBuilder[];
    status: "mapped" | "absent" | "limited";
  }> => {
    const localRecords: VolumeBuilder[] = [];
    const regionEnd = absoluteOffset(region, region.end);
    if (depth > limits.maxDepth) {
      noteOmission(
        "depth-limited",
        region,
        parentLogicalPath,
        region.origin,
        regionEnd,
        `Volume depth limit ${limits.maxDepth} reached under ${parentLogicalPath}.`,
      );
      return { volumes: localRecords, status: "limited" };
    }
    const fvImageSection = mode === "fv-image-section";
    const discovered = scanFirmwareVolumes(
      region,
      UEFI_FIRMWARE_LIMITS.scanRecords,
      {
        reserve,
        skipNested: true,
        // The payload of an FV-image leaf begins with its sole volume header.
        ...(fvImageSection
          ? {
              signatureEnd: region.start + FV_HEADER_LAYOUT.signatureOffset + 4,
            }
          : {}),
      },
    );
    for (const rejected of discovered.rejected) {
      noteLimitations([
        `_FVH hit under ${parentLogicalPath} at ${hex(rejected.absoluteBase)} not confirmed: ${rejected.reason}.`,
      ]);
      if (mode !== "embedded-probe" && rejected.truncation !== undefined) {
        incompleteFraming = true;
      }
    }

    let volumeLimitFrom: number | undefined;
    let mappedThrough = region.origin;
    for (const { header } of discovered.volumes) {
      if (volumesDiscovered >= limits.maxVolumes) {
        volumeLimitFrom = header.absoluteBase;
        break;
      }
      volumesDiscovered += 1;
      noteUnparsedRange(
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
      if (header.fileSystem === "unsupported") {
        noteUnparsedRange(
          region,
          volume.offset + volume.header_length,
          volumeEnd,
          logicalPath,
          {
            detail: unsupportedVolumeBodyReason(header),
            classification: "unsupported-file-system",
          },
        );
      } else {
        await walkFiles(volume, header, depth, region, volumeEnd);
      }
      const lastFile = volume.ffs_files.at(-1);
      for (const issue of inspectFirmwareVolumeExtension(
        region,
        header,
        reserve,
        checkpoint,
        lastFile === undefined ? undefined : lastFile.offset + lastFile.length,
      )) {
        noteOmission(
          issue.kind,
          region,
          logicalPath,
          issue.offset,
          issue.offset + issue.length,
          issue.detail,
        );
      }
      mappedThrough = volumeEnd;
      localRecords.push(volume);
    }
    if (volumeLimitFrom !== undefined || discovered.limit !== null) {
      const detail =
        discovered.limit === "structural-records"
          ? `Structural record limit reached during volume scan under ${parentLogicalPath}.`
          : discovered.limit === "candidates"
            ? `Volume candidate limit reached under ${parentLogicalPath}.`
            : `Firmware volume budget ${limits.maxVolumes} reached under ${parentLogicalPath}.`;
      noteOmission(
        "size-truncated",
        region,
        parentLogicalPath,
        volumeLimitFrom ?? mappedThrough,
        regionEnd,
        detail,
      );
      return { volumes: localRecords, status: "limited" };
    }
    if (fvImageSection) {
      noteUnparsedRange(region, mappedThrough, regionEnd, parentLogicalPath, {
        detail:
          localRecords.length === 0
            ? `FV-image section ${parentLogicalPath} does not begin with a confirmed firmware volume.`
            : `FV-image section ${parentLogicalPath} extends beyond its firmware volume.`,
      });
    } else if (mode !== "embedded-probe" || localRecords.length > 0) {
      noteUnparsedRange(region, mappedThrough, regionEnd, parentLogicalPath);
    }
    return {
      volumes: localRecords,
      status: localRecords.length > 0 ? "mapped" : "absent",
    };
  };

  const walkFiles = async (
    volume: VolumeBuilder,
    header: FirmwareVolumeHeader,
    depth: number,
    parentRegion: ScanRegion,
    volumeEnd: number,
  ): Promise<void> => {
    const volumeLocalEnd = localOffsetOf(parentRegion, volumeEnd);
    const fileAreaStart = Math.min(header.firstFileLocal, volumeLocalEnd);
    const fileArea = subRegion(parentRegion, header.localBase, volumeLocalEnd);
    const notePadding = ({ offset, length }: FfsPaddingRange): void =>
      noteUnparsedRange(
        fileArea,
        offset,
        offset + length,
        volume.logical_path,
        {
          nonErased: true,
          detail: `Unexpected FFS alignment bytes at ${hex(offset)}: ${length} bytes.`,
        },
      );
    for (const padding of header.filePrefixPadding) notePadding(padding);
    let cursor = fileAreaStart;
    const reserveFile = (): boolean =>
      filesDiscovered < limits.maxFiles && reserve();
    while (cursor < fileArea.end) {
      checkpoint();
      const read = readFfsHeader(
        fileArea,
        cursor,
        header.erasePolarity,
        reserveFile,
      );
      const at = absoluteOffset(fileArea, cursor);
      if (read.kind === "limited") {
        noteOmission(
          "size-truncated",
          fileArea,
          volume.logical_path,
          at,
          volumeEnd,
          structuralLimitReached
            ? `Structural record limit reached during FFS walk in ${volume.logical_path}.`
            : `FFS file budget ${limits.maxFiles} reached inside ${volume.logical_path}.`,
        );
        return;
      }
      if (read.kind === "unusable-header") {
        noteOmission(
          "unparsed-region",
          fileArea,
          volume.logical_path,
          read.offset,
          read.offset + read.length,
          read.detail,
        );
        cursor = read.nextLocal;
        continue;
      }
      if (read.kind === "unparsed") {
        noteUnparsedRange(
          fileArea,
          read.offset,
          read.offset + read.length,
          volume.logical_path,
          {
            nonErased: true,
            detail:
              read.detail ??
              `Unparsed FFS suffix in ${volume.logical_path} at ${hex(read.offset)}: ${read.length} bytes.`,
          },
        );
        return;
      }
      if (read.kind === "end") break;
      const fileHeader = read.header;
      filesDiscovered += 1;
      for (const implausibility of fileHeader.implausibilities) {
        noteLimitations([
          `FFS header implausibility "${implausibility}" at ${hex(fileHeader.absoluteBase)} in ${volume.logical_path}.`,
        ]);
      }
      const logicalPath = `${volume.logical_path}/FFS:${fileHeader.nameGuid ?? "unknown"}@${hex(fileHeader.absoluteBase)}`;
      const truncatesArea =
        fileHeader.extentIssue === "declared-length-truncates-region";
      if (fileHeader.extentIssue !== null) {
        const detail = `FFS declares ${fileHeader.declaredLength} bytes; observed ${fileHeader.observedLength} bytes with a ${fileHeader.headerLength}-byte header (${fileHeader.extentIssue}).`;
        noteOmission(
          fileHeader.extentIssue === "unusable-header-state"
            ? "unparsed-region"
            : "size-truncated",
          fileArea,
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.absoluteBase + fileHeader.observedLength,
          detail,
        );
        if (fileHeader.extentIssue !== "unusable-header-state")
          noteIntegrity(
            "size-truncation",
            logicalPath,
            fileHeader.absoluteBase,
            fileHeader.observedLength,
            detail,
            fileArea.sourceStream ?? null,
          );
      } else if (fileHeader.typeCode === 0xf0) {
        noteOmission(
          "pad-file",
          fileArea,
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.absoluteBase + fileHeader.observedLength,
          "Pad file extent retained.",
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
      const checksum = checkFfsFileIntegrity(fileArea, fileHeader);
      if (checksum.verdict === "invalid") {
        noteIntegrity(
          "ffs-file-checksum-mismatch",
          logicalPath,
          checksum.offset,
          checksum.length,
          checksum.detail,
          fileArea.sourceStream ?? null,
        );
      }
      const observedBytes =
        sliceRegion(
          parentRegion,
          fileHeader.absoluteBase,
          fileHeader.observedLength,
        ) ?? Buffer.alloc(0);

      const sections: SectionBuilder[] = [];
      let uiString: string | null = null;
      if (
        fileHeader.typeCode !== 0xf0 &&
        fileHeader.body !== null &&
        fileHeader.bodyIssue !== null
      ) {
        const { start, end } = fileHeader.body;
        noteOmission(
          "unparsed-region",
          fileArea,
          logicalPath,
          absoluteOffset(fileArea, start),
          absoluteOffset(fileArea, end),
          `FFS file ${logicalPath} has a valid header but its data is not marked valid.`,
        );
      } else if (fileHeader.typeCode !== 0xf0 && fileHeader.body !== null) {
        const { start: bodyStart, end: observedEnd } = fileHeader.body;
        const sectioned =
          fileHeader.typeCode >= 0x02 && fileHeader.typeCode <= 0x0f;
        if (sectioned) {
          uiString = await walkSectionChain(
            subRegion(fileArea, bodyStart, observedEnd),
            logicalPath,
            depth,
            {
              volumeOffset: volume.offset,
              records: sections,
              largeFile:
                fileHeader.headerLength === FFS_HEADER_LAYOUT.extendedLength,
            },
          );
        } else {
          if (!truncatesArea)
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
              "embedded-probe",
            );
          }
        }
      }

      volume.ffs_files.push({
        source_stream: fileArea.sourceStream ?? null,
        offset: fileHeader.absoluteBase,
        header_length: fileHeader.headerLength,
        length: fileHeader.observedLength,
        declared_length: fileHeader.declaredLength,
        guid: fileHeader.nameGuid ?? "ffffffff-ffff-ffff-ffff-ffffffffffff",
        type_code: fileHeader.typeCode,
        type_name: ffsTypeNameFor(fileHeader.typeCode),
        attributes: fileHeader.attributes,
        alignment: String(fileHeader.dataAlignment) as FileBuilder["alignment"],
        state: fileHeader.rawState,
        state_flags: fileHeader.stateFlags as FileBuilder["state_flags"],
        checksum: checksum.verdict,
        ui_string: uiString,
        logical_path: logicalPath,
        volume_offset: volume.offset,
        sha256: sha256Hex(observedBytes),
        sections,
      });

      if (read.padding !== null) notePadding(read.padding);
      cursor = read.nextLocal;
    }
    noteUnparsedRange(
      fileArea,
      absoluteOffset(fileArea, cursor),
      volumeEnd,
      volume.logical_path,
    );
  };

  const walkSectionChain = async (
    region: ScanRegion,
    parentLogicalPath: string,
    depth: number,
    owner: {
      volumeOffset: number;
      records: SectionBuilder[];
      largeFile?: boolean;
    },
  ): Promise<string | null> => {
    const { volumeOffset, records, largeFile } = owner;
    const walked = walkSections(region, reserve, largeFile);
    if (walked.remainder !== null) {
      const limited = walked.remainder.kind === "limited";
      noteOmission(
        limited ? "size-truncated" : "unparsed-region",
        region,
        parentLogicalPath,
        absoluteOffset(region, walked.remainder.start),
        absoluteOffset(region, region.end),
        limited
          ? `Structural record limit reached during section walk under ${parentLogicalPath}.`
          : `Section chain under ${parentLogicalPath} ends with incomplete framing.`,
      );
    }
    for (const padding of walked.nonzeroPadding) {
      noteOmission(
        "unparsed-region",
        region,
        parentLogicalPath,
        absoluteOffset(region, padding.start),
        absoluteOffset(region, padding.end),
        `Nonzero alignment bytes in section chain under ${parentLogicalPath}.`,
      );
    }
    let uiString: string | null = null;
    for (const [index, draft] of walked.sections.entries()) {
      checkpoint();
      const logicalPath = `${parentLogicalPath}/section[${index}]`;
      const payload =
        draft.payload === null
          ? null
          : payloadOf(region, draft.payload.start, draft.payload.end);
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
        malformed: draft.malformed,
        type_code: draft.typeCode,
        type_name: (SECTION_TYPE_NAME_BY_CODE[draft.typeCode] ??
          "unknown") as SectionBuilder["type_name"],
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
        noteOmission(
          draft.truncated ? "size-truncated" : "unparsed-region",
          region,
          logicalPath,
          draft.absoluteBase,
          draft.absoluteBase + draft.observedLength,
          draft.framingIssue === undefined
            ? `Section ${logicalPath} framing is ${draft.malformed ? "malformed" : "truncated"}; declared ${draft.declaredLength} bytes, observed ${draft.observedLength}.`
            : `Section ${logicalPath} has invalid framing. ${draft.framingIssue}`,
        );
        continue;
      }
      if (draft.payload === null || payload === null) continue;
      const content = draft.content;
      if (content.kind === "unsupported") {
        noteCarrierGap(
          logicalPath,
          payload,
          content.gap,
          content.detail ??
            `No decoder is available for ${compression.kind} section ${logicalPath}.`,
        );
        continue;
      }
      if (content.kind !== "decode") {
        // Stored GUID wrappers describe already-readable child sections.
        if (compression.kind === "none") payloads.set(logicalPath, payload);
        else if (
          content.kind === "stored-sections" &&
          content.guidedIntegrityUnchecked
        )
          noteLimitations([
            `Guided integrity status for ${logicalPath} was not verified.`,
          ]);
        if (
          draft.payload.start === draft.payload.end &&
          content.kind !== "ui"
        ) {
          if (content.kind === "volume")
            noteOmission(
              "unparsed-region",
              region,
              logicalPath,
              draft.absoluteBase,
              draft.absoluteBase + draft.observedLength,
              `FV-image section ${logicalPath} has an empty payload.`,
            );
          continue;
        }
      }
      const payloadRegion = subRegion(
        region,
        draft.payload.start,
        draft.payload.end,
      );
      if (content.kind === "ui") {
        const name = decodeUiString(payload.bytes);
        if (name.kind === "found") uiString ??= name.value;
        else {
          const limited = name.kind === "limited";
          noteOmission(
            limited ? "size-truncated" : "unparsed-region",
            region,
            logicalPath,
            limited
              ? payload.range.offset + UI_STRING_BYTES
              : draft.absoluteBase,
            draft.absoluteBase + draft.observedLength,
            limited
              ? `UI name under ${logicalPath} exceeds the ${UI_STRING_BYTES}-byte display limit.`
              : `UI section ${logicalPath} has no complete NUL-terminated UTF-16 name.`,
          );
        }
      } else if (content.kind === "volume") {
        const nested = await scanVolumesInRegion(
          payloadRegion,
          depth + 1,
          volumeOffset,
          logicalPath,
          "fv-image-section",
        );
        record.sub_volumes = nested.volumes.map((entry) => entry.logical_path);
      } else if (content.kind === "stored-sections") {
        if (depth >= limits.maxDepth) {
          noteOmission(
            "depth-limited",
            payloadRegion,
            logicalPath,
            payload.range.offset,
            payload.range.offset + payload.range.length,
            `Section depth limit reached under ${logicalPath}.`,
          );
        } else {
          const childUi = await walkSectionChain(
            payloadRegion,
            logicalPath,
            depth + 1,
            owner,
          );
          uiString ??= childUi;
        }
      } else if (content.kind === "decode") {
        const decoded = await resolveDecodedSection(
          payload,
          logicalPath,
          depth,
          content.format,
        );
        if (decoded === null) continue;
        const decodedRegion: ScanRegion = {
          buffer: decoded.bytes,
          start: 0,
          end: decoded.bytes.length,
          origin: 0,
          sourceStream: logicalPath,
        };
        // Select the outer framing before scanning for embedded volume magic.
        const leadingSection = startsWithSectionFrame(decodedRegion);
        const rootVolume = leadingSection
          ? parseFirmwareVolumeHeader(
              decodedRegion,
              decodedRegion.start,
              reserve,
            )
          : null;
        const sectionsFirst =
          leadingSection &&
          (rootVolume === null || rootVolume.implausibilities.length > 0);
        if (!sectionsFirst) {
          const nested = await scanVolumesInRegion(
            decodedRegion,
            depth + 1,
            volumeOffset,
            `${logicalPath}/${decoded.format}`,
            "embedded-probe",
          );
          record.sub_volumes = nested.volumes.map(
            (entry) => entry.logical_path,
          );
          if (nested.status === "absent") {
            noteUnparsedRange(
              decodedRegion,
              0,
              decoded.bytes.length,
              logicalPath,
              {
                detail: `Decoded stream at ${logicalPath} has no confirmed volume or section framing; decoded bytes retained.`,
              },
            );
          }
        } else {
          const childUi = await walkSectionChain(
            decodedRegion,
            logicalPath,
            depth + 1,
            { volumeOffset, records },
          );
          uiString ??= childUi;
        }
      }
    }
    return uiString;
  };

  const resolveDecodedSection = async (
    payload: UefiPayload,
    logicalPath: string,
    depth: number,
    format: UefiDecodeFormat,
  ): Promise<UefiDecodedStream | null> => {
    const maxOutputBytes = Math.min(
      UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
      UEFI_FIRMWARE_LIMITS.decodedBytes - decodedBytes,
    );
    if (depth >= limits.maxDepth)
      return noteCarrierGap(
        logicalPath,
        payload,
        "depth-limited",
        `Decode depth limit reached under ${logicalPath}.`,
      );
    if (maxOutputBytes <= 0)
      return noteCarrierGap(
        logicalPath,
        payload,
        "size-truncated",
        `Aggregate decoded output limit reached under ${logicalPath}.`,
      );
    if (payload.bytes.length === 0)
      return noteCarrierGap(
        logicalPath,
        payload,
        "unparsed-region",
        `Empty ${format} carrier at ${logicalPath}.`,
      );
    let carrier = payload;
    if (format === "zlib") {
      const peeled = peelAmiZlibPayload(payload.bytes);
      if (
        peeled === null ||
        peeled.declaredCompressedSize !== peeled.stream.length
      ) {
        return noteCarrierGap(
          logicalPath,
          payload,
          "unparsed-region",
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
      format,
      maxOutputBytes,
    });
    checkpoint();
    if (!decodedResult.ok) {
      return noteCarrierGap(
        logicalPath,
        payload,
        decodedResult.reason === "output-limit"
          ? "size-truncated"
          : "unparsed-region",
        `${format} decode failed at ${logicalPath}: ${decodedResult.message}`,
      );
    }
    const outcome = decodedResult.outcome;
    if (outcome.bytes.length > maxOutputBytes) {
      return noteCarrierGap(
        logicalPath,
        payload,
        "size-truncated",
        `Decoded output exceeded its byte limit at ${logicalPath}.`,
      );
    }
    if (outcome.consumedBytes < carrier.range.length) {
      const unusedBytes = carrier.range.length - outcome.consumedBytes;
      recordOmission({
        kind: "unparsed-region",
        logical_path: logicalPath,
        source_stream: carrier.sourceStream,
        range: {
          offset: carrier.range.offset + outcome.consumedBytes,
          length: unusedBytes,
        },
        detail: `The ${format} decoder did not examine the final ${unusedBytes} bytes of the carrier at ${logicalPath}.`,
      });
      carrier = {
        bytes: carrier.bytes.subarray(0, outcome.consumedBytes),
        sourceStream: carrier.sourceStream,
        range: {
          offset: carrier.range.offset,
          length: outcome.consumedBytes,
        },
      };
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

  const { tables: pspTables, candidates: pspCandidates } = scanPspDirectories(
    image,
    reserve,
  );

  return {
    inputSize: image.length,
    payloads,
    decodedStreams,
    compressedCarriers,
    volumes,
    unknownRegions,
    integrity,
    pspTables,
    pspCandidates,
    limitations,
    omissions,
    coverage:
      structuralLimitReached ||
      incompleteFraming ||
      omissions.some(({ kind }) => kind !== "pad-file")
        ? "partial"
        : "complete",
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

const UI_STRING_BYTES = 1024;

function decodeUiString(
  payload: Buffer,
): { kind: "found"; value: string | null } | { kind: "limited" | "malformed" } {
  const reader = new BinaryReader(payload, true, "UEFI UI section");
  const limit = Math.min(
    payload.length - (payload.length % 2),
    UI_STRING_BYTES,
  );
  for (let end = 0; end < limit; end += 2) {
    if (reader.u16(end) === 0)
      return {
        kind: "found",
        value: end === 0 ? null : payload.toString("utf16le", 0, end),
      };
  }
  return { kind: payload.length > UI_STRING_BYTES ? "limited" : "malformed" };
}
