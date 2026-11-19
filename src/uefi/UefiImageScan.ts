import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  isErasedFfsHeader,
  parseFfsFileHeader,
  verifyFfsFileChecksum,
  type FfsFileHeader,
} from "./FfsFile.js";
import {
  AMD_ZLIB_HEADER_LENGTH,
  peelAmiZlibPayload,
  sectionPayloadBuffer,
  sectionPayloadRegion,
  walkSections,
  type SectionDraft,
} from "./FfsSections.js";
import {
  parseFirmwareVolumeHeader,
  scanFirmwareVolumes,
  type FirmwareVolumeHeader,
} from "./FirmwareVolume.js";
import {
  absoluteOffset,
  imageRegion,
  isWindowUniform,
  localOffsetOf,
  sampleUniformity,
  sliceRegion,
  alignUp,
  type ScanRegion,
} from "./UefiBytes.js";

/** Successful external LZMA decode handed back to the scan. */
export interface UefiLzmaDecodeOutcome {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly decoderVersion: string;
}

/** One decodable stream submitted to the injected decode lane. */
export interface UefiLzmaDecodeRequest {
  readonly payload: Buffer;
  readonly logicalPath: string;
  /** Compression format of payload: zlib-wrapped stream or LZMA (default). */
  readonly format: "lzma" | "zlib";
  /** Physical image range of the compressed stream, when inside the image. */
  readonly physicalRange: {
    readonly offset: number;
    readonly length: number;
  } | null;
}

/**
 * Injected LZMA lane: returns null for format, decoder and budget failures;
 * the scan records those as limitations and keeps walking.
 */
export type UefiLzmaDecoder = (
  request: UefiLzmaDecodeRequest,
) => Promise<UefiLzmaDecodeOutcome | null>;

export interface UefiScanLimits {
  readonly maxDepth: number;
  readonly maxVolumes: number;
  readonly maxFiles: number;
}

export interface PspEntryRecord {
  readonly type: number | null;
  readonly declaredLocation: number | null;
  readonly declaredSize: number | null;
  readonly imageOffset: number | null;
  readonly sha256: string | null;
  readonly locationBasis: "declared-unverified";
}

export interface PspTableRecord {
  readonly offset: number;
  readonly length: number;
  readonly tableMagic: "$PSP" | "$2B" | "unknown";
  readonly totalEntries: number | null;
  readonly entries: readonly PspEntryRecord[];
  readonly entryStrideBasis: "header-declared" | "assumed-16" | "unknown";
}

export interface PspCandidateRecord {
  readonly offset: number;
  readonly magic: string;
  readonly reason: string;
}

export interface UefiImageScanSummary {
  readonly inputSize: number;
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

const digestOf = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const hex = (value: number): string => `0x${value.toString(16)}`;

/** Table names mirror the contract enum; unlisted codes report "unknown". */
const ffsTypeNameFor = (code: number): UefiFfsFileRecord["type_name"] => {
  const name = FFS_TYPE_NAME_BY_CODE[code] as string | undefined;
  return (name ?? "unknown") as UefiFfsFileRecord["type_name"];
};

const alignmentFor = (exponent: number): number =>
  1 << Math.max(0, Math.min(7, exponent));

const PSP_MAGICS = ["$PSP", "$2B"] as const;
const PSP_MAXIMUM_ENTRIES = 96;
const PSP_HEADER_OFFSET_LENGTH = 0x10;

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
): Promise<UefiImageScanSummary> => {
  const imageBuffer = image;
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
  ): void => {
    integrity.push({
      kind,
      logical_path: logicalPath,
      range: { offset, length },
      detail,
    });
  };

  const noteLimitations = (lines: readonly string[]): void => {
    if (limitations.length >= 512) {
      budgetExhausted = true;
      return;
    }
    for (const line of lines) {
      if (limitations.length < 512) {
        limitations.push(line);
      }
      if (limitations.length >= 512) {
        budgetExhausted = true;
        break;
      }
    }
  };

  const classifyLeftover = (
    region: ScanRegion,
    absoluteStart: number,
    absoluteEnd: number,
    logicalPath: string,
  ): void => {
    const length = absoluteEnd - absoluteStart;
    if (length <= 0) {
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
    } else if (sampleUniformity(region.buffer, localStart, localEnd) >= 0.99) {
      classification = "erased-ff";
      erasure = "0xff";
    }
    unknownRegions.push({
      offset: absoluteStart,
      length,
      sha256: digestOf(region.buffer.subarray(localStart, localEnd)),
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
      Math.max(0, limits.maxVolumes - volumesDiscovered),
    );
    volumesDiscovered += discovered.volumes.length;
    if (volumesDiscovered >= limits.maxVolumes) {
      budgetExhausted = true;
      noteLimitations([
        `Firmware volume budget ${limits.maxVolumes} reached under ${parentLogicalPath}.`,
      ]);
    }
    for (const rejected of discovered.rejected) {
      noteLimitations([
        `_FVH hit under ${parentLogicalPath} at ${hex(rejected.absoluteBase)} not confirmed: ${rejected.reason}.`,
      ]);
    }

    // Hits inside an already accepted volume are its nested copies living in
    // file payloads; the child scans rediscover them inside their own region.
    const accepted: FirmwareVolumeHeader[] = [];
    for (const { header } of discovered.volumes) {
      const insideEarlierVolume = accepted.some(
        (earlier) =>
          header.absoluteBase >= earlier.absoluteBase &&
          header.absoluteBase <
            earlier.absoluteBase + Math.max(1, earlier.declaredLength),
      );
      if (insideEarlierVolume) {
        continue;
      }
      accepted.push(header);

      const logicalPath = `${parentLogicalPath}/FV@${hex(header.absoluteBase)}`;
      if (!header.checksumValid) {
        noteIntegrity(
          "fv-checksum-mismatch",
          logicalPath,
          header.absoluteBase,
          header.headerLength,
          "Volume header checksum does not sum to zero over HeaderLength bytes.",
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
        logical_path: logicalPath,
        offset: header.absoluteBase,
        length: Math.max(1, volumeEnd - header.absoluteBase),
        declared_length: header.declaredLength,
        depth,
        parent_offset: parentOffset,
        sha256: digestOf(observed ?? Buffer.alloc(0)),
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
      const mappedThrough =
        lastFile == null
          ? volume.offset + volume.header_length
          : lastFile.offset + lastFile.length;
      classifyLeftover(region, mappedThrough, volumeEnd, logicalPath);
      localRecords.push(volume);
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
    };
    if (fileArea.end <= fileArea.start) {
      return;
    }
    let cursor = fileArea.start;
    while (cursor + 24 <= fileArea.end) {
      if (filesDiscovered >= limits.maxFiles) {
        budgetExhausted = true;
        noteLimitations([
          `FFS file budget ${limits.maxFiles} reached inside ${volume.logical_path}.`,
        ]);
        break;
      }
      if (isErasedFfsHeader(parentRegion, cursor, header.erasePolarity)) {
        break;
      }
      filesDiscovered += 1;
      const fileHeader = parseFfsFileHeader(
        parentRegion,
        cursor,
        header.erasePolarity,
      );
      if (fileHeader == null) {
        noteLimitations([
          `FFS header unparseable in ${volume.logical_path} at ${hex(absoluteOffset(parentRegion, cursor))}; file walk ends.`,
        ]);
        break;
      }
      for (const implausibility of fileHeader.implausibilities) {
        noteLimitations([
          `FFS header implausibility "${implausibility}" at ${hex(fileHeader.absoluteBase)} in ${volume.logical_path}.`,
        ]);
      }
      const logicalPath = `${volume.logical_path}/FFS:${fileHeader.nameGuid ?? "unknown"}`;
      const observedEnd = Math.min(
        fileHeader.localBase + fileHeader.declaredLength,
        fileArea.end,
      );
      const truncatesArea =
        fileHeader.localBase + fileHeader.declaredLength > fileArea.end;
      const declaredBelowHeader =
        fileHeader.declaredLength < fileHeader.headerLength;
      if (declaredBelowHeader) {
        noteIntegrity(
          "size-truncation",
          logicalPath,
          fileHeader.absoluteBase,
          Math.max(1, fileHeader.headerLength),
          "FFS declared length is smaller than the header itself.",
        );
      }
      if (truncatesArea && !declaredBelowHeader) {
        noteIntegrity(
          "size-truncation",
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.declaredLength,
          "FFS file declared length exceeds the volume area; walk ends at the volume boundary.",
        );
      }
      if (!fileHeader.headerChecksumValid) {
        noteIntegrity(
          "ffs-header-checksum-mismatch",
          logicalPath,
          fileHeader.absoluteBase,
          fileHeader.headerLength,
          "FFS header checksum does not sum to zero with State and File bytes zeroed.",
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
        );
      }
      const observedBytes =
        sliceRegion(
          parentRegion,
          fileHeader.absoluteBase,
          observedEnd - fileHeader.localBase,
        ) ?? Buffer.alloc(0);

      const sectionChain =
        fileHeader.typeCode === 0xf0 || declaredBelowHeader
          ? {
              sections: [] as SectionBuilder[],
              ui_string: null as string | null,
            }
          : await walkSectionChain(
              fileArea,
              fileHeader,
              observedEnd,
              logicalPath,
              depth,
              volume.offset,
            );

      volume.ffs_files.push({
        offset: fileHeader.absoluteBase,
        header_length: fileHeader.headerLength,
        length: Math.max(1, observedEnd - fileHeader.localBase),
        guid: fileHeader.nameGuid ?? "ffffffff-ffff-ffff-ffff-ffffffffffff",
        type_code: fileHeader.typeCode,
        type_name: ffsTypeNameFor(fileHeader.typeCode),
        attributes: fileHeader.attributes,
        alignment: String(
          alignmentFor(fileHeader.alignmentExponent),
        ) as FileBuilder["alignment"],
        state: fileHeader.rawState,
        state_flags: fileHeader.stateFlags as FileBuilder["state_flags"],
        checksum,
        ui_string: sectionChain.ui_string,
        logical_path: logicalPath,
        volume_offset: volume.offset,
        sha256: digestOf(observedBytes),
        sections: sectionChain.sections,
      });

      if (truncatesArea) {
        break;
      }
      const fileAlignment = Math.max(
        8,
        alignmentFor(fileHeader.alignmentExponent),
      );
      const advanceBase = Math.max(
        fileHeader.localBase + fileHeader.declaredLength,
        fileHeader.localBase + fileHeader.headerLength,
      );
      // FFS alignment is relative to the volume base, not the owning region.
      cursor =
        header.localBase +
        alignUp(advanceBase - header.localBase, fileAlignment);
    }
  };

  /**
   * Probe one raw FFS body for an embedded firmware volume (AMI ROM-hole
   * pattern: the file body is the volume, its zero vector misparses as a
   * zero-size section frame). Admission stays with scanVolumesInRegion —
   * alignment, plausibility, checksum and budgets decide; null keeps the
   * caller on its unframed-body path.
   */
  const resolveEmbeddedVolumeInRawBody = async (
    region: ScanRegion,
    fileHeader: FfsFileHeader,
    observedEnd: number,
    fileLogicalPath: string,
    depth: number,
    volumeOffset: number,
  ): Promise<VolumeBuilder[] | null> => {
    const bodyStart = fileHeader.localBase + fileHeader.headerLength;
    const bodyEnd = Math.min(region.end, observedEnd);
    if (
      bodyStart < region.start ||
      bodyStart + FV_HEADER_LAYOUT.minimumLength > bodyEnd
    ) {
      return null;
    }
    const nested = await scanVolumesInRegion(
      {
        buffer: region.buffer,
        start: bodyStart,
        end: bodyEnd,
        origin: absoluteOffset(region, bodyStart),
      },
      depth + 1,
      volumeOffset,
      `${fileLogicalPath}/embedded`,
    );
    if (nested.length === 0) {
      return null;
    }
    noteLimitations([
      `Raw file body ${fileLogicalPath} reinterpreted: ${nested.length} embedded firmware volume(s) start in the body (${nested
        .map((entry) => entry.logical_path)
        .join(
          ", ",
        )}); the leading bytes are the volume header, not a section frame.`,
    ]);
    return nested;
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
    fileHeader: FfsFileHeader,
    observedEnd: number,
    fileLogicalPath: string,
    depth: number,
    volumeOffset: number,
  ): Promise<{ sections: SectionBuilder[]; ui_string: string | null }> => {
    const walked = walkSections(
      region,
      fileHeader.localBase + fileHeader.headerLength,
      observedEnd,
      (code) => SECTION_TYPE_NAME_BY_CODE[code] ?? "unknown",
    );
    // A raw file body can carry a firmware volume header directly (AMI ROM
    // holes): the volume zero vector misparses as a zero-size section frame
    // and stops the chain. Confirm an embedded volume before keeping that
    // frame; without one, the observed framing stays untouched.
    const bogusUnframedOnly =
      walked.sections.length === 0 ||
      (walked.sections.length === 1 &&
        walked.sections[0] != null &&
        walked.sections[0].declaredLength < walked.sections[0].headerLength);
    if (fileHeader.typeCode === 0x01 && bogusUnframedOnly) {
      const embedded = await resolveEmbeddedVolumeInRawBody(
        region,
        fileHeader,
        observedEnd,
        fileLogicalPath,
        depth,
        volumeOffset,
      );
      if (embedded != null) {
        return { sections: [], ui_string: null };
      }
    }
    if (walked.sections.length === 0) {
      classifyLeftover(
        region,
        fileHeader.absoluteBase + fileHeader.headerLength,
        absoluteOffset(region, observedEnd),
        fileLogicalPath,
      );
      return { sections: [], ui_string: null };
    }
    const records: SectionBuilder[] = [];
    let uiString: string | null = null;
    for (const [index, draft] of walked.sections.entries()) {
      const sectionLogicalPath = `${fileLogicalPath}/section[${index}]`;
      const record = draftToRecord(draft, region);
      if (draft.truncated && draft.typeName !== "unknown") {
        // Preserve the omission for a real (recognizable) section that declares
        // more bytes than the file/volume holds; junk frames from raw bodies
        // have an unknown type and must not masquerade as truncation.
        truncationObserved = true;
        noteLimitations([
          `Section ${sectionLogicalPath} declares ${draft.declaredLength} bytes but only ${draft.observedLength} are present; payload is truncated.`,
        ]);
      }
      if (draft.typeCode === 0x15 && uiString == null) {
        uiString = decodeUiString(sectionPayloadBuffer(region, draft));
      }
      if (draft.typeCode === 0x17) {
        const payload = sectionPayloadRegion(region, draft);
        if (payload == null) {
          noteLimitations([
            `Firmware-volume-image section is empty: ${sectionLogicalPath}.`,
          ]);
        } else {
          const nested = await scanVolumesInRegion(
            payload,
            depth + 1,
            volumeOffset,
            sectionLogicalPath,
          );
          record.sub_volumes = nested.map((entry) => entry.logical_path);
        }
      } else if (
        draft.typeCode === 0x02 &&
        isDecodableKind(draft.compression.kind)
      ) {
        await resolveDecodedSection(
          draft,
          region,
          record,
          sectionLogicalPath,
          depth,
          volumeOffset,
        );
      } else if (draft.typeCode === 0x01) {
        noteLimitations([
          `Compression section ${sectionLogicalPath} (${draft.compression.kind === "none" ? "unclassified" : "EFI standard"}) stays undecoded; payload retained as section.`,
        ]);
      } else if (
        draft.typeCode === 0x02 &&
        draft.compression.kind === "unknown-guid"
      ) {
        noteLimitations([
          `GUIDed section ${sectionLogicalPath} has an unknown definition GUID ${draft.compression.guid ?? "unparseable"}; payload retained as section.`,
        ]);
      }
      records.push(record);
    }
    return { sections: records, ui_string: uiString };
  };

  const draftToRecord = (
    draft: SectionDraft,
    region: ScanRegion,
  ): SectionBuilder => {
    const payloadBuffer = sectionPayloadBuffer(region, draft);
    const compression: SectionBuilder["compression"] =
      draft.compression.kind === "none"
        ? { kind: "none" }
        : {
            kind: draft.compression.kind,
            guid: draft.compression.guid,
            data_offset: draft.compression.dataOffset,
            attributes: draft.compression.attributes,
          };
    return {
      offset: draft.absoluteBase,
      header_length: draft.headerLength,
      length: draft.observedLength,
      type_code: draft.typeCode,
      type_name: draft.typeName as SectionBuilder["type_name"],
      sha256:
        payloadBuffer == null || payloadBuffer.length === 0
          ? digestOf(Buffer.alloc(0))
          : digestOf(payloadBuffer),
      compression,
      sub_volumes: [],
    };
  };

  /**
   * Decode one compressed guided section payload and map the section stream
   * it contains. Decoded offsets are positions inside the decompressed stream,
   * anchored at the compressed stream's image-absolute start; the physical
   * owning volume keeps linking through parent_offset and logical paths.
   * AMI-zlib payloads carry a 0x100-byte AMD section header in front of the
   * zlib-wrapped stream; decoding covers the stream behind it.
   */
  const resolveDecodedSection = async (
    draft: SectionDraft,
    region: ScanRegion,
    record: SectionBuilder,
    sectionLogicalPath: string,
    depth: number,
    volumeOffset: number,
  ): Promise<void> => {
    const payload = sectionPayloadBuffer(region, draft) ?? Buffer.alloc(0);
    if (payload.length === 0) {
      return;
    }
    if (depth >= limits.maxDepth) {
      budgetExhausted = true;
      noteLimitations([
        `Compressed payload at ${sectionLogicalPath} exceeds depth ${limits.maxDepth}; retained as section.`,
      ]);
      return;
    }
    const format =
      draft.compression.kind === "ami-zlib"
        ? ("zlib" as const)
        : ("lzma" as const);
    const dataOffset =
      draft.compression.kind === "none" ? 0 : draft.compression.dataOffset;
    let stream = payload;
    let streamOffset = dataOffset;
    if (format === "zlib") {
      const peeled = peelAmiZlibPayload(payload);
      if (peeled == null) {
        noteLimitations([
          `AMI-zlib payload at ${sectionLogicalPath} is shorter than the ${hex(AMD_ZLIB_HEADER_LENGTH)}-byte AMD section header; retained as section.`,
        ]);
        return;
      }
      if (peeled.declaredCompressedSize !== peeled.stream.length) {
        noteLimitations([
          `AMI-zlib payload at ${sectionLogicalPath} declares ${peeled.declaredCompressedSize} compressed bytes for a ${peeled.stream.length}-byte stream; decoding the remaining stream.`,
        ]);
      }
      stream = peeled.stream;
      streamOffset += AMD_ZLIB_HEADER_LENGTH;
    }
    const outcome = await decodeLzma({
      payload: stream,
      logicalPath: sectionLogicalPath,
      format,
      physicalRange:
        region.buffer === imageBuffer
          ? { offset: draft.absoluteBase + streamOffset, length: stream.length }
          : null,
    });
    if (outcome == null) {
      noteLimitations([
        `${format === "zlib" ? "zlib" : "LZMA"} decode failed or was unavailable for ${sectionLogicalPath}; payload retained as section.`,
      ]);
      return;
    }
    const decodedRegion: ScanRegion = {
      buffer: outcome.bytes,
      start: 0,
      end: outcome.bytes.length,
      origin: draft.absoluteBase + dataOffset,
    };
    const nested = await scanVolumesInRegion(
      decodedRegion,
      depth + 1,
      volumeOffset,
      `${sectionLogicalPath}/${format === "zlib" ? "zlib" : "lzma"}`,
    );
    record.sub_volumes = nested.map((entry) => entry.logical_path);
  };

  const imageRegion0 = imageRegion(image, 0, image.length);
  await scanVolumesInRegion(imageRegion0, 0, null, "flash");

  scanPspDirectories(image, pspTables, pspCandidates);

  return {
    inputSize: image.length,
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

const isDecodableKind = (kind: SectionDraft["compression"]["kind"]): boolean =>
  kind === "lzma-custom" || kind === "lzmaf86" || kind === "ami-zlib";

/** Printable-prefixed text from a 0x15 user-interface section payload. */
const decodeUiString = (payload: Buffer | null): string | null => {
  if (payload == null || payload.length === 0) {
    return null;
  }
  let text = "";
  for (const byte of payload) {
    if (byte === 0x00) {
      break;
    }
    if (byte < 0x20 || byte > 0x7e) {
      text += "�";
    } else {
      text += String.fromCharCode(byte);
    }
  }
  return text.slice(0, 512);
};

const scanPspDirectories = (
  image: Buffer,
  tables: PspTableRecord[],
  candidates: PspCandidateRecord[],
): void => {
  for (const magic of PSP_MAGICS) {
    const magicBytes = Buffer.from(magic, "ascii");
    let searchFrom = 0;
    while (searchFrom >= 0 && searchFrom < image.length - magicBytes.length) {
      const hit = image.indexOf(magicBytes, searchFrom);
      if (hit < 0) {
        break;
      }
      searchFrom = hit + 1;
      const totalEntries = image[hit + 4] ?? 0xff;
      const tableLength = 0x10 + totalEntries * 16;
      const plausible =
        totalEntries > 0 &&
        totalEntries <= PSP_MAXIMUM_ENTRIES &&
        hit + tableLength <= image.length;
      if (!plausible) {
        candidates.push({
          offset: hit,
          magic,
          reason: "implausible-entry-count",
        });
        continue;
      }
      const entries: PspEntryRecord[] = [];
      for (let index = 0; index < totalEntries; index += 1) {
        const entryStart = hit + 0x10 + index * 16;
        if (entryStart + 16 > image.length) {
          break;
        }
        const entryBytes = image.subarray(entryStart, entryStart + 16);
        entries.push({
          type: entryBytes[0] ?? null,
          declaredLocation: entryBytes.readUInt32LE(4),
          declaredSize: entryBytes.readUInt32LE(8),
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
        entryStrideBasis: "assumed-16",
      });
    }
  }
};
