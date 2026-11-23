import { Buffer } from "node:buffer";
import { Budget } from "../domain/budget.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import type {
  UefiExtractResult,
  UefiFfsFileRecord,
  UefiIntegrityRecord,
  UefiSectionRecord,
  UefiUnknownRegion,
  UefiVolumeRecord,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import type { UefiDecodeFailureReason } from "./UefiLzmaProtocol.js";
import {
  AMD_ZLIB_HEADER_LENGTH,
  peelAmdZlibPayload,
  type UefiDecodeFormat,
} from "./FfsSections.js";
import {
  absoluteOffset,
  isWindowUniform,
  localOffsetOf,
  type ScanRegion,
} from "./UefiBytes.js";
import type { PspCandidateRecord, PspTableRecord } from "./UefiPspDirectory.js";

/** Successful external LZMA decode handed back to the scan. */
export interface UefiLzmaDecodeOutcome {
  readonly bytes: Buffer;
  readonly decoderVersion: string;
  readonly consumedBytes: number;
}

/** One decodable stream submitted to the injected decode lane. */
export interface UefiLzmaDecodeRequest {
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

export interface UefiScanLimits {
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

export interface UefiDecodedStream {
  readonly bytes: Buffer;
  readonly format: UefiDecodeFormat;
  readonly decoderVersion: string;
  readonly carrier: UefiPayload;
}

export type ScanOmission = UefiExtractResult["extraction_gaps"][number];

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

export type VolumeBuilder = {
  -readonly [K in keyof UefiVolumeRecord]: UefiVolumeRecord[K];
};
export type FileBuilder = {
  -readonly [K in keyof UefiFfsFileRecord]: UefiFfsFileRecord[K];
};
export type SectionBuilder = {
  -readonly [K in keyof UefiSectionRecord]: UefiSectionRecord[K];
};

export const hexOffset = (value: number): string => `0x${value.toString(16)}`;

/** Mutable state, record budgets, gap/integrity accounting, and decode lane for one UEFI scan. */
export class UefiScanContext {
  readonly payloads = new Map<string, UefiPayload>();
  readonly decodedStreams = new Map<string, UefiDecodedStream>();
  readonly compressedCarriers = new Map<string, UefiPayload>();
  readonly volumes: VolumeBuilder[] = [];
  readonly unknownRegions: UefiUnknownRegion[] = [];
  readonly omissions: ScanOmission[] = [];
  readonly integrity: UefiIntegrityRecord[] = [];
  readonly limitations: string[] = [];

  decodedBytes = 0;
  readonly #records = new Budget(UEFI_FIRMWARE_LIMITS.scanRecords);
  structuralLimitReached = false;
  incompleteFraming = false;
  filesDiscovered = 0;
  volumesDiscovered = 0;

  constructor(
    readonly limits: UefiScanLimits,
    private readonly decodeLzma: UefiLzmaDecoder,
    readonly checkpoint: () => void,
  ) {}

  readonly reserve = (count = 1): boolean => {
    this.checkpoint();
    if (this.structuralLimitReached) return false;
    if (this.#records.tryCharge(count)) return true;
    this.structuralLimitReached = true;
    this.limitations.push(
      `Structural record limit ${UEFI_FIRMWARE_LIMITS.scanRecords} reached.`,
    );
    return false;
  };

  payloadOf(region: ScanRegion, start: number, end: number): UefiPayload {
    return {
      bytes: region.buffer.subarray(start, end),
      sourceStream: region.sourceStream ?? null,
      range: { offset: absoluteOffset(region, start), length: end - start },
    };
  }

  noteIntegrity(
    kind: UefiIntegrityRecord["kind"],
    logicalPath: string,
    offset: number,
    length: number,
    detail: string,
    sourceStream: string | null,
  ): void {
    if (!this.reserve()) return;
    this.integrity.push({
      kind,
      logical_path: logicalPath,
      source_stream: sourceStream,
      range: { offset, length },
      detail,
    });
  }

  noteLimitations(lines: readonly string[]): void {
    for (const line of lines) {
      if (this.limitations.length >= 512) break;
      this.limitations.push(line);
    }
  }

  recordOmission(omission: ScanOmission): void {
    this.omissions.push(omission);
    if (omission.kind !== "pad-file") this.noteLimitations([omission.detail]);
  }

  noteOmission(
    kind: ScanOmission["kind"],
    region: ScanRegion,
    logicalPath: string,
    start: number,
    end: number,
    detail: string,
  ): void {
    if (start >= end) return;
    this.recordOmission({
      kind,
      logical_path: logicalPath,
      source_stream: region.sourceStream ?? null,
      range: { offset: start, length: end - start },
      detail,
    });
  }

  noteCarrierGap(
    path: string,
    payload: UefiPayload,
    kind: ScanOmission["kind"],
    detail: string,
  ): null {
    if (payload.bytes.length > 0) this.compressedCarriers.set(path, payload);
    this.recordOmission({
      kind,
      logical_path: path,
      source_stream: payload.sourceStream,
      range: payload.range.length > 0 ? payload.range : null,
      detail,
    });
    return null;
  }

  noteUnparsedRange(
    region: ScanRegion,
    absoluteStart: number,
    absoluteEnd: number,
    logicalPath: string,
    known?: {
      detail: string;
      classification?: UefiUnknownRegion["classification"];
      nonErased?: true;
    },
  ): void {
    const length = absoluteEnd - absoluteStart;
    if (length <= 0) return;
    if (!this.reserve()) {
      this.noteOmission(
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
    this.unknownRegions.push({
      source_stream: region.sourceStream ?? null,
      offset: absoluteStart,
      length,
      sha256: sha256Hex(region.buffer.subarray(localStart, localEnd)),
      classification: known?.classification ?? classification,
      erasure,
    });
    if (known !== undefined || erasure === "none") {
      this.noteOmission(
        "unparsed-region",
        region,
        logicalPath,
        absoluteStart,
        absoluteEnd,
        known?.detail ??
          `Unparsed region under ${logicalPath} at ${hexOffset(absoluteStart)}, ${length} bytes.`,
      );
    }
  }

  async resolveDecodedSection(
    payload: UefiPayload,
    logicalPath: string,
    depth: number,
    format: UefiDecodeFormat,
  ): Promise<UefiDecodedStream | null> {
    const maxOutputBytes = Math.min(
      UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
      UEFI_FIRMWARE_LIMITS.decodedBytes - this.decodedBytes,
    );
    if (depth >= this.limits.maxDepth)
      return this.noteCarrierGap(
        logicalPath,
        payload,
        "depth-limited",
        `Decode depth limit reached under ${logicalPath}.`,
      );
    if (maxOutputBytes <= 0)
      return this.noteCarrierGap(
        logicalPath,
        payload,
        "size-truncated",
        `Aggregate decoded output limit reached under ${logicalPath}.`,
      );
    if (payload.bytes.length === 0)
      return this.noteCarrierGap(
        logicalPath,
        payload,
        "unparsed-region",
        `Empty ${format} carrier at ${logicalPath}.`,
      );
    let carrier = payload;
    if (format === "zlib") {
      const peeled = peelAmdZlibPayload(payload.bytes);
      if (
        peeled === null ||
        peeled.declaredCompressedSize !== peeled.stream.length
      ) {
        return this.noteCarrierGap(
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
    const decodedResult = await this.decodeLzma({
      payload: carrier.bytes,
      format,
      maxOutputBytes,
    });
    this.checkpoint();
    if (!decodedResult.ok) {
      return this.noteCarrierGap(
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
      return this.noteCarrierGap(
        logicalPath,
        payload,
        "size-truncated",
        `Decoded output exceeded its byte limit at ${logicalPath}.`,
      );
    }
    if (outcome.consumedBytes < carrier.range.length) {
      const unusedBytes = carrier.range.length - outcome.consumedBytes;
      this.recordOmission({
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
    this.decodedBytes += outcome.bytes.length;
    const decoded: UefiDecodedStream = {
      bytes: outcome.bytes,
      format,
      decoderVersion: outcome.decoderVersion,
      carrier,
    };
    this.decodedStreams.set(logicalPath, decoded);
    return decoded;
  }

  toSummary(
    inputSize: number,
    pspTables: readonly PspTableRecord[],
    pspCandidates: readonly PspCandidateRecord[],
  ): UefiImageScanSummary {
    return {
      inputSize,
      payloads: this.payloads,
      decodedStreams: this.decodedStreams,
      compressedCarriers: this.compressedCarriers,
      volumes: this.volumes,
      unknownRegions: this.unknownRegions,
      integrity: this.integrity,
      pspTables,
      pspCandidates,
      limitations: this.limitations,
      omissions: this.omissions,
      coverage:
        this.structuralLimitReached ||
        this.incompleteFraming ||
        this.omissions.some(({ kind }) => kind !== "pad-file")
          ? "partial"
          : "complete",
    };
  }
}
