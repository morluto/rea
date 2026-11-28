import { decodeStrictUtf8, strictUtf8Decoder } from "../domain/strictUtf8.js";
import type { KnownCoverageStatus } from "../domain/coverage.js";
import type {
  GpuCodeObjectsInput,
  GpuCodeObjects,
  GpuObject,
  GpuKernel,
} from "../domain/gpu/gpuCodeObjects.js";
import {
  CCOB_MAGIC,
  CLANG_BUNDLE_MAGIC,
  findLegacyCcobRecoveryTotal,
  readClangBundleDirectory,
  readCcobHeader,
} from "./ClangOffloadBundle.js";
import {
  gpuObject,
  gpuLocation,
  recordDeclaredGpuDecodedSize,
  type GpuPayloadTarget,
} from "./GpuObject.js";
import { readCudaTarget } from "./CudaTarget.js";
import { readCudaFatbinary } from "./CudaFatbinary.js";
import {
  decodeGpuPayload,
  decodeGpuPayloadStream,
  isTruncatedGpuPayloadFailure,
} from "./GpuPayloadCodec.js";
import {
  projectZstandardFrameAllowance,
  ZstandardFrameAllowanceError,
  type ZstandardFrameAllowance,
} from "../domain/compression/zstandardFrameAllowance.js";
import {
  ZSTANDARD_MAGIC_BYTES,
  zstandardFrameKind,
} from "../domain/compression/zstandardFrameWire.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { createHash } from "node:crypto";
import { scheduler } from "node:timers/promises";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  hasElfMagic,
  isBinaryStringReadLimit,
  NATIVE_STRUCTURE_LIMIT,
} from "../domain/binaryContainer.js";
import { hasDosMzMagic } from "../domain/dosMz.js";
import {
  readElfSectionDirectory,
  readPeSectionDirectory,
  type NativeSectionDirectory,
} from "../domain/native/nativeSectionDirectory.js";
import {
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../resources/index.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  CONTAINER_SCAN_CHUNK_BYTES,
  GpuBufferSource,
  checkGpuRange,
  GpuReportCapacityFailure,
  gpuCount,
  nextGpuContainerOffset,
  readGpuNativeDirectory,
  rejectGpu,
  type GpuSource,
} from "./GpuSource.js";
import {
  DEFAULT_GPU_REPORT_BYTES,
  GPU_CONTAINER_NESTING_LIMIT,
  GPU_OBJECT_BYTES_LIMIT,
  GPU_WORK_BYTES_LIMIT,
  formatGpuByteBudget,
  gpuBudgetParameterForLimit,
  resolveGpuCodeObjectsBudgets,
  type GpuCodeObjectsBudgets,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  readGpuElfKernels,
  readAmdElfMetadata,
  type AmdElfMetadata,
} from "./GpuElfKernels.js";
import {
  createPtxTargetTracker,
  createPtxVersionScanner,
  ptxTargetIdentity,
  readPtxKernels,
  readPtxTarget,
} from "./PtxKernels.js";
import type { AmdGpuTargetIdentity } from "./AmdGpuTarget.js";

const PTX_INVALID_UTF8 = "PTX is not valid UTF-8 text";

const readPtxText = (
  bytes: Buffer,
  coverage: "complete" | "prefix",
): string | null => {
  try {
    if (coverage === "complete") return decodeStrictUtf8(bytes, "preserve");
    // The probe can end in the middle of an otherwise valid scalar.
    return strictUtf8Decoder("preserve").decode(bytes, { stream: true });
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    return null;
  }
};

interface MeteredGpuSource extends GpuSource {
  /** Read for format recognition: charges aggregate work without enforcing max_object_bytes. */
  readWorkOnly?(
    offset: number,
    size: number,
    maximumBytes: number,
  ): Promise<Buffer>;
  /** Read bytes whose object and work budgets were already reserved by the caller. */
  readPrecharged?(offset: number, size: number): Promise<Buffer>;
}

/** File declarations only. Every child range stays in its named parent coordinate space. */
export class GpuInventory {
  readonly objects: GpuObject[] = [];
  readonly kernels: GpuKernel[] = [];
  readonly ptx_artifacts: GpuCodeObjects["ptx_artifacts"] = [];
  readonly limitations = [
    "Static declarations only; no GPU execution, SASS disassembly, host launch correlation or runtime compatibility was verified.",
    "Object IDs are positional identities scoped to artifact.sha256. Locations inside decoded objects name their containing object; they are not file offsets.",
  ];
  discovery: KnownCoverageStatus = "complete";
  examined_sections = 0;
  unknown_section_names = 0;
  #factBytes = 0;
  #workBytes = 0;
  readonly #outerTargets = new WeakMap<
    GpuObject,
    string | AmdGpuTargetIdentity | null
  >();
  readonly #meteredSources = new WeakSet<GpuSource>();
  readonly #selectedObjects: ReadonlySet<string> | undefined;
  readonly #selectedTargets: ReadonlySet<string> | undefined;
  readonly #budgets: GpuCodeObjectsBudgets;
  constructor(
    readonly input: GpuCodeObjectsInput,
    readonly signal?: AbortSignal,
  ) {
    this.#budgets = resolveGpuCodeObjectsBudgets(input);
    this.#selectedObjects =
      input.object_ids === undefined ? undefined : new Set(input.object_ids);
    this.#selectedTargets =
      input.targets === undefined ? undefined : new Set(input.targets);
    const headerBytes =
      jsonValueByteLength(
        { path: input.path, limitations: this.limitations },
        DEFAULT_GPU_REPORT_BYTES,
      ) + 2;
    const baselineRequired = headerBytes + 1024;
    if (baselineRequired > this.#budgets.maxReportBytes)
      throw new GpuReportCapacityFailure(
        this.#budgets.maxReportBytes,
        baselineRequired,
      );
    this.#factBytes = baselineRequired;
  }
  #retain(value: JsonValue): void {
    const bytes = jsonValueByteLength(value, this.#budgets.maxReportBytes);
    if (bytes + 2 > this.#budgets.maxReportBytes - this.#factBytes) {
      const required =
        bytes <= this.#budgets.maxReportBytes
          ? this.#factBytes + bytes + 2
          : undefined;
      throw new GpuReportCapacityFailure(
        this.#budgets.maxReportBytes,
        required,
      );
    }
    this.#factBytes += bytes + 2;
  }
  #add(row: GpuObject, amdTarget?: AmdGpuTargetIdentity | null): void {
    if (row.raw_flags !== null || row.bundle_id !== null)
      this.#outerTargets.set(row, amdTarget ?? row.target);
    this.#retain(row);
    this.#retain(" ".repeat(32)); // Reserve all later inspection-state changes.
    this.objects.push(row);
  }
  #decoded(row: GpuObject, sha256: string, size: number): void {
    this.#retain({ sha256, decoded_size: size });
    row.sha256 = sha256;
    row.decoded_size = size;
  }
  #encodedExtent(row: GpuObject, size: number): void {
    this.#retain({ encoded_size: size, size });
    row.encoded_size = size;
    row.location.size = size;
  }
  #objectLimitations(row: GpuObject, messages: string[]): void {
    this.#retain(messages);
    row.limitations.push(...messages);
  }
  /** Reserve aggregate work bytes without enforcing max_object_bytes (used for structure reads bounded by max_structure_bytes). */
  #reserveWork(...sizes: (number | bigint)[]): void {
    let workBytes = this.#workBytes;
    const { maxWorkBytes } = this.#budgets;
    for (const size of sizes) {
      if (size > maxWorkBytes - workBytes) {
        const workLabel =
          maxWorkBytes % (1024 * 1024) === 0
            ? `${String(maxWorkBytes / (1024 * 1024))} MiB`
            : `${String(maxWorkBytes)} bytes`;
        throw new BinaryResourceFailure(
          "structure",
          maxWorkBytes,
          `GPU reads/decoding exceed ${workLabel} per inspection`,
          GPU_WORK_BYTES_LIMIT,
          "bytes",
        );
      }
      workBytes += Number(size);
    }
    this.#workBytes = workBytes;
  }
  /** Verify that every single-buffer read/decode size fits within max_object_bytes. */
  #checkObjectBytes(...sizes: (number | bigint)[]): void {
    const { maxObjectBytes } = this.#budgets;
    for (const size of sizes) {
      if (size > maxObjectBytes)
        throw new BinaryResourceFailure(
          "structure",
          maxObjectBytes,
          `GPU read/decoding buffer exceeds the ${String(maxObjectBytes)}-byte object budget`,
          GPU_OBJECT_BYTES_LIMIT,
          "bytes",
        );
    }
  }
  /** Reserve input/output work atomically, before any payload allocation or read. */
  #budgetWork(...sizes: (number | bigint)[]): void {
    this.#checkObjectBytes(...sizes);
    this.#reserveWork(...sizes);
  }
  /** Read a format-recognition chunk without enforcing max_object_bytes or borrowing NATIVE_STRUCTURE_LIMIT. */
  #readRecognitionChunk(
    source: MeteredGpuSource,
    offset: number,
    size: number,
    maximumBytes: number,
  ): Promise<Buffer> {
    if (source.readWorkOnly !== undefined)
      return source.readWorkOnly(offset, size, maximumBytes);
    if (source.readBounded !== undefined)
      return source.readBounded(offset, size, maximumBytes);
    return source.read(offset, size);
  }
  /**
   * Atomically verify and reserve work for a read of `readBytes` plus `extra`
   * (such as decoded output), avoiding double-charging `readBytes` when
   * `source` itself meters every underlying read.
   */
  #reserveReadWork(
    source: GpuSource,
    readBytes: number,
    ...extra: (number | bigint)[]
  ): void {
    if (!this.#meteredSources.has(source)) {
      this.#budgetWork(readBytes, ...extra);
      return;
    }
    const previous = this.#workBytes;
    this.#budgetWork(readBytes, ...extra);
    // `source.read` will charge `readBytes` when it executes; retain only `extra`.
    this.#workBytes = previous;
    if (extra.length > 0) this.#reserveWork(...extra);
  }
  #selected(row: GpuObject): boolean {
    return (
      (this.#selectedObjects === undefined ||
        this.#selectedObjects.has(row.id)) &&
      (this.#selectedTargets === undefined ||
        (row.target !== null && this.#selectedTargets.has(row.target)))
    );
  }
  async inspect(
    source: MeteredGpuSource,
    depth = 0,
  ): Promise<GpuCodeObjects["format"]> {
    assertArtifactReadActive(this.signal);
    if (depth > 8)
      throw new BinaryResourceFailure(
        "structure",
        8,
        "GPU container nesting exceeds eight levels",
        GPU_CONTAINER_NESTING_LIMIT,
      );
    const prefixLength = Math.min(32, source.size);
    const prefix = await this.#readRecognitionChunk(
      source,
      0,
      prefixLength,
      32,
    );
    if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0xed, 0x55, 0xba]))) {
      await this.#cuda(source);
      return "cuda-fatbin";
    }
    if (
      prefix.subarray(0, CLANG_BUNDLE_MAGIC.length).equals(CLANG_BUNDLE_MAGIC)
    ) {
      await this.#hip(source, depth);
      return "hip-bundle";
    }
    if (prefix.subarray(0, CCOB_MAGIC.length).equals(CCOB_MAGIC)) {
      await this.#hip(source, depth);
      return "hip-bundle";
    }
    if (hasElfMagic(prefix) || hasDosMzMagic(prefix)) {
      const elf = prefix[0] === 0x7f;
      const directory = await readGpuNativeDirectory(
        source,
        elf
          ? readElfSectionDirectory(
              source.size,
              this.#budgets.maxStructureBytes === undefined
                ? undefined
                : { structureBytes: this.#budgets.maxStructureBytes },
            )
          : readPeSectionDirectory(
              source.size,
              this.#budgets.maxStructureBytes,
            ),
        () => yieldArtifactRead(this.signal),
        this.#budgets.maxStructureBytes,
      );
      if (elf && (directory.machine === 190 || directory.machine === 224)) {
        const row = gpuObject(source, {
          offset: 0,
          size: source.size,
          kind: directory.machine === 190 ? "cubin" : "amdgpu",
        });
        this.#add(row);
        if (directory.machine === 190) {
          this.#target(row, readCudaTarget(source, directory));
        }
        if (directory.machine === 224)
          await this.#amdPayload(source, row, directory);
        else await this.#payload(source, row);
      } else {
        const parentMetered = this.#meteredSources.has(source);
        for (const section of directory.sections) {
          this.examined_sections++;
          if (section.name === null) {
            this.unknown_section_names++;
            this.discovery = "partial";
            continue;
          }
          if (!isGpuSection(section.name)) continue;
          if (!section.file_backed || section.compressed) {
            this.discovery = "partial";
            const message = `GPU section ${section.index} has no supported uncompressed file range`;
            this.#retain(message);
            this.limitations.push(message);
            continue;
          }
          const offset = gpuCount(section.offset),
            size = gpuCount(section.size);
          // A section is a coordinate space with an explicit physical backing, including PE short names.
          const row = gpuObject(source, {
            offset: offset,
            size: size,
            kind: "native-section",
            metadata: {
              offset: section.header_offset,
              size:
                directory.format === "elf"
                  ? directory.bits === 64
                    ? 64
                    : 40
                  : 40,
            },
          });
          row.location.section_index = section.index;
          row.location.section_name = section.name;
          this.#add(row);
          const sectionSource: MeteredGpuSource = {
            size,
            containerId: row.id,
            maxObjectBytes: this.#budgets.maxObjectBytes,
            read: (start, length) => {
              checkGpuRange(size, start, length, this.#budgets.maxObjectBytes);
              if (!parentMetered) this.#budgetWork(length);
              return source.read(offset + start, length);
            },
            readBounded: (start, length, maximumBytes, limitName) => {
              checkGpuRange(size, start, length, maximumBytes, limitName);
              if (!parentMetered) {
                if (limitName === NATIVE_STRUCTURE_LIMIT)
                  this.#reserveWork(length);
                else this.#budgetWork(length);
              }
              return source.readBounded !== undefined
                ? source.readBounded(
                    offset + start,
                    length,
                    maximumBytes,
                    limitName,
                  )
                : source.read(offset + start, length);
            },
            readWorkOnly: (start, length, maximumBytes) => {
              checkGpuRange(size, start, length, maximumBytes);
              if (!parentMetered) this.#reserveWork(length);
              if (source.readWorkOnly !== undefined)
                return source.readWorkOnly(
                  offset + start,
                  length,
                  maximumBytes,
                );
              return source.readBounded !== undefined
                ? source.readBounded(offset + start, length, maximumBytes)
                : source.read(offset + start, length);
            },
            readPrecharged: (start, length) => {
              checkGpuRange(size, start, length, size);
              if (source.readPrecharged !== undefined)
                return source.readPrecharged(offset + start, length);
              return source.readBounded !== undefined
                ? source.readBounded(offset + start, length, size)
                : source.read(offset + start, length);
            },
          };
          this.#meteredSources.add(sectionSource);
          try {
            await this.inspect(sectionSource, depth + 1);
            row.inspection = "complete";
          } catch (cause) {
            this.#retainFailure(row, cause);
            this.discovery = "partial";
          }
        }
      }
      return directory.format;
    }
    // PTX is positively identified by its directives, never by extension or arbitrary embedded text.
    // Recognize the leading `.version <major>.<minor>` header incrementally without retaining
    // chunks so non-GPU inputs fail with unsupported_target and peak heap stays at 1x probeSize.
    const probeSize = Math.min(source.size, this.#budgets.maxReportBytes);
    const scanner = createPtxVersionScanner();
    let firstPiece: Buffer | undefined;
    let scanned = 0;
    let verdict: "yes" | "no" | "incomplete" = "incomplete";
    let chunkLimit = 4096;
    while (scanned < probeSize && verdict === "incomplete") {
      if (scanned > 0) await yieldArtifactRead(this.signal);
      const want = Math.min(chunkLimit, probeSize - scanned);
      const piece = await this.#readRecognitionChunk(
        source,
        scanned,
        want,
        CONTAINER_SCAN_CHUNK_BYTES,
      );
      firstPiece = scanned === 0 ? piece : undefined;
      scanned += piece.length;
      verdict = scanner.feed(piece);
      chunkLimit = CONTAINER_SCAN_CHUNK_BYTES;
    }
    if (verdict === "incomplete" && scanned === source.size)
      verdict = scanner.finish();
    if (verdict === "no") {
      firstPiece = undefined;
      throw new BinaryFormatFailure(
        "unsupported",
        "No supported CUDA/HIP container or PTX declarations were identified",
      );
    }
    if (verdict === "incomplete") {
      firstPiece = undefined;
      throw new BinaryResourceFailure(
        "structure",
        this.#budgets.maxReportBytes,
        `Standalone text recognition exceeds the ${String(this.#budgets.maxReportBytes)}-byte PTX budget before a target was established`,
        "gpu-retained-report-bytes",
        "bytes",
      );
    }
    let probe: Buffer;
    const metered = this.#meteredSources.has(source);
    if (firstPiece !== undefined && scanned === probeSize) {
      // Single <= 4 KiB read already holds the complete probe buffer.
      this.#checkObjectBytes(probeSize);
      if (!metered) this.#reserveWork(probeSize);
      probe = firstPiece;
      firstPiece = undefined;
    } else {
      // Release the recognition chunk before reading into one probe-sized buffer
      // so peak heap remains 1x max_report_bytes rather than 2x.
      firstPiece = undefined;
      this.#checkObjectBytes(probeSize);
      const remainingWork = metered
        ? Math.max(0, probeSize - scanned)
        : probeSize;
      if (remainingWork > 0) this.#reserveWork(remainingWork);
      probe =
        metered && source.readPrecharged !== undefined
          ? await source.readPrecharged(0, probeSize)
          : await source.read(0, probeSize);
    }
    const complete = probe.length === source.size;
    const text = readPtxText(probe, complete ? "complete" : "prefix");
    // Replacement decoding may identify a malformed candidate. Only strict
    // text can establish its target or become retained PTX text evidence.
    const targetFacts = readPtxTarget(
      text ?? probe.toString("utf8"),
      this.#budgets.maxTokenBytes,
    );
    if (targetFacts.recognized) {
      const row = gpuObject(source, {
        offset: 0,
        size: source.size,
        kind: "ptx",
      });
      if (text === null) row.limitations.push(PTX_INVALID_UTF8);
      if (!complete)
        row.limitations.push(
          `PTX target scan reached the ${formatGpuByteBudget(this.#budgets.maxReportBytes)} text budget before all module directives were examined.`,
        );
      if (complete && text !== null) {
        row.target = targetFacts.target;
        if (targetFacts.limitation !== null)
          row.limitations.push(targetFacts.limitation);
      }
      if (row.limitations.length > 0) {
        row.inspection = text === null ? "malformed" : "partial";
        this.discovery = "partial";
      }
      this.#add(row);
      await this.#payload(
        complete
          ? new GpuBufferSource(
              probe,
              source.containerId,
              this.#budgets.maxObjectBytes,
            )
          : source,
        row,
        complete
          ? { standalonePtx: text === null ? null : { text, targetFacts } }
          : undefined,
      );
      return "ptx";
    }
    if (!complete)
      throw new BinaryResourceFailure(
        "structure",
        this.#budgets.maxReportBytes,
        `Standalone text recognition exceeds the ${String(this.#budgets.maxReportBytes)}-byte PTX budget before a target was established`,
        "gpu-retained-report-bytes",
        "bytes",
      );
    throw new BinaryFormatFailure(
      "unsupported",
      "No supported CUDA/HIP container or PTX declarations were identified",
    );
  }
  #retainFailure(row: GpuObject, cause: unknown): void {
    if (cause instanceof GpuReportCapacityFailure) throw cause;
    if (cause instanceof ZstandardFrameAllowanceError)
      throw projectZstandardFrameAllowance("inspect_gpu_code_objects", cause);
    if (cause instanceof AnalysisError) throw cause;
    const capacity =
      cause instanceof BinaryResourceFailure || isBinaryStringReadLimit(cause);
    if (!capacity && !(cause instanceof BinaryFormatFailure)) throw cause;
    row.inspection = capacity
      ? "capacity"
      : cause.kind === "unsupported"
        ? "unsupported"
        : "malformed";
    const message =
      cause instanceof BinaryResourceFailure
        ? gpuCapacityLimitationMessage(cause)
        : cause.message;
    this.#objectLimitations(row, [message]);
  }
  async #payload(
    source: GpuSource,
    row: GpuObject,
    {
      amdMetadata,
      declaredDecodedSize,
      standalonePtx,
    }: {
      amdMetadata?: AmdElfMetadata;
      declaredDecodedSize?: number | bigint;
      standalonePtx?: {
        text: string;
        targetFacts: ReturnType<typeof readPtxTarget>;
      } | null;
    } = {},
  ): Promise<void> {
    if (this.input.analysis !== "kernels") return;
    if (!this.#selected(row)) {
      row.inspection = "not-selected";
      return;
    }
    if (row.compression === "unsupported") {
      row.inspection = "unsupported";
      return;
    }
    try {
      const decodedSize = declaredDecodedSize ?? row.decoded_size;
      let coverage: "complete" | "partial" = "complete";
      if (
        row.kind === "ptx" &&
        (decodedSize === null || decodedSize > this.#budgets.maxReportBytes)
      )
        throw new BinaryResourceFailure(
          "structure",
          this.#budgets.maxReportBytes,
          `PTX text exceeds the ${String(this.#budgets.maxReportBytes)}-byte retained report budget`,
          "gpu-retained-report-bytes",
          "bytes",
        );
      const compression = row.compression;
      const compressed =
        compression === "zstd" ||
        compression === "zlib" ||
        compression === "lz4";
      if (compressed && decodedSize === null)
        rejectGpu("Compressed GPU object has no decoded length");
      // Standalone PTX probes already reserved and read their complete buffer.
      if (standalonePtx === undefined)
        this.#reserveReadWork(
          source,
          row.location.size,
          ...(compressed ? [decodedSize!] : []),
        );
      let bytes = await source.read(row.location.offset, row.location.size);
      if (compressed) {
        try {
          bytes = await decodeGpuPayload(
            bytes,
            compression,
            Number(decodedSize),
            this.signal,
            this.#budgets.maxObjectBytes,
          );
        } catch (cause) {
          if (cause instanceof ZstandardFrameAllowanceError)
            throw projectZstandardFrameAllowance(
              "inspect_gpu_code_objects",
              cause,
            );
          if (
            cause instanceof BinaryResourceFailure ||
            cause instanceof AnalysisError
          )
            throw cause;
          assertArtifactReadActive(this.signal);
          throw new BinaryFormatFailure(
            "malformed",
            "GPU payload decompression failed",
          );
        }
      }
      const decodedSha256 = sha256Hex(bytes);
      this.#decoded(row, decodedSha256, bytes.length);
      const decoded = new GpuBufferSource(
        bytes,
        row.id,
        this.#budgets.maxObjectBytes,
      );
      if (row.kind === "ptx") {
        // Standalone discovery already retained this encoding failure.
        if (standalonePtx === null) return;
        // NVIDIA appends NUL alignment padding to an uncompressed PTX entry.
        let length = bytes.length;
        if (row.raw_flags !== null)
          while (length > 0 && bytes[length - 1] === 0) length--;
        const content = bytes.subarray(0, length);
        const text = standalonePtx?.text ?? readPtxText(content, "complete");
        if (text === null) return rejectGpu(PTX_INVALID_UTF8);
        const artifact = {
          id: `${row.id}/ptx`,
          object_id: row.id,
          sha256: length === bytes.length ? decodedSha256 : sha256Hex(content),
          media_type: "text/x-ptx" as const,
          encoding: "utf-8" as const,
          byte_length: content.length,
          text,
          location: gpuLocation(decoded, 0, content.length),
        };
        this.#retain(artifact);
        this.ptx_artifacts.push(artifact);
        // Extract target directives and kernel entries in a single token pass
        // for embedded PTX; on a parse failure fall back to readPtxTarget so
        // any target directives after a malformed entry are still preserved.
        const tracker =
          standalonePtx === undefined ? createPtxTargetTracker() : undefined;
        const firstKernel = this.kernels.length;
        const finishTarget = (target: ReturnType<typeof readPtxTarget>) => {
          const limitation = this.#target(row, {
            value: target.target,
            key: target.target,
            scope: "exact",
            ...(target.limitation === null
              ? {}
              : { limitation: target.limitation }),
          });
          if (limitation === undefined) return;
          coverage = "partial";
          for (let index = firstKernel; index < this.kernels.length; index++) {
            this.#retain([limitation]);
            this.kernels[index]!.limitations.push(limitation);
          }
        };
        try {
          for (const { kernel, coverage: kernelCoverage } of readPtxKernels(
            text,
            row.id,
            tracker,
            this.#budgets,
          )) {
            this.#retain(kernel);
            this.kernels.push(kernel);
            if (kernelCoverage === "partial") coverage = "partial";
          }
        } catch (cause) {
          if (!(cause instanceof GpuReportCapacityFailure))
            finishTarget(
              standalonePtx?.targetFacts ??
                readPtxTarget(text, this.#budgets.maxTokenBytes),
            );
          throw cause;
        }
        finishTarget(standalonePtx?.targetFacts ?? tracker!.facts());
      } else if (row.kind === "cubin" || row.kind === "amdgpu") {
        if (row.kind === "amdgpu" && isLlvmBitcode(bytes))
          throw new BinaryFormatFailure("unsupported", LLVM_BITCODE_LIMITATION);
        coverage = await this.#elfFacts(decoded, row, row.kind, amdMetadata);
      } else {
        row.inspection = "unsupported";
        this.#objectLimitations(row, [
          "Payload kind is outside kernel metadata coverage",
        ]);
        return;
      }
      row.inspection = coverage;
    } catch (cause) {
      this.#retainFailure(row, cause);
    }
  }
  #target(row: GpuObject, payload: GpuPayloadTarget): string | undefined {
    const selectedTarget = row.target;
    const outerIdentity = this.#outerTargets.get(row) ?? null;
    const outer =
      typeof outerIdentity === "string"
        ? outerIdentity
        : (outerIdentity?.key ?? null);
    const payloadKey =
      payload.scope === "amdgpu"
        ? (payload.identity?.key ?? null)
        : payload.key;
    const hasOuter = outer !== null;
    let state: GpuObject["target_consistency"] = "unknown";
    if (payload.value !== null && !hasOuter) state = "single-source";
    else if (outer !== null && payloadKey !== null) {
      if (payload.scope === "cuda-base") {
        const base = /^sm_([0-9]+)[a-z]*$/u.exec(outer)?.[1];
        const inner = /^sm_([0-9]+)$/u.exec(payloadKey)?.[1];
        if (base !== undefined && inner !== undefined)
          state = base === inner ? "base-only" : "conflict";
      } else if (payload.scope === "amdgpu") {
        if (outer === payloadKey) state = "consistent";
        else
          state =
            typeof outerIdentity === "object" &&
            outerIdentity !== null &&
            payload.identity !== null &&
            outerIdentity.processor === payload.identity.processor
              ? "unknown"
              : "conflict";
      } else if (ptxTargetIdentity(outer) === ptxTargetIdentity(payloadKey))
        state = "consistent";
      else state = "conflict";
    }
    this.#retain({
      payload_target: payload.value,
      cuda_target_header: payload.cudaHeader ?? null,
      amd_target_metadata: payload.amdMetadata ?? null,
      amd_pal_metadata: payload.amdPal ?? null,
      target_consistency: state,
      target: selectedTarget ?? payload.value,
    });
    row.payload_target = payload.value;
    row.cuda_target_header = payload.cudaHeader ?? null;
    row.amd_target_metadata = payload.amdMetadata ?? null;
    row.amd_pal_metadata = payload.amdPal ?? null;
    row.target_consistency = state;
    if (selectedTarget === null) row.target = payload.value;
    if (row.target === null) this.discovery = "partial";
    if (state !== "conflict" && payload.limitation === undefined) return;
    const message =
      state === "conflict"
        ? `Conflicting target declarations: inventory ${outer}; payload ${payload.value}. Target agreement is not established.`
        : payload.limitation!;
    if (!row.limitations.includes(message))
      this.#objectLimitations(row, [message]);
    return message;
  }
  async #amdPayload(
    source: GpuSource,
    row: GpuObject,
    directory?: NativeSectionDirectory,
  ): Promise<void> {
    const parentMetered = this.#meteredSources.has(source);
    const child: GpuSource = {
      size: row.location.size,
      containerId: row.id,
      maxObjectBytes: this.#budgets.maxObjectBytes,
      read: (offset, size) => {
        checkGpuRange(
          row.location.size,
          offset,
          size,
          this.#budgets.maxObjectBytes,
        );
        if (!parentMetered) this.#budgetWork(size);
        return source.read(row.location.offset + offset, size);
      },
      readBounded: (offset, size, maximumBytes, limitName) => {
        checkGpuRange(row.location.size, offset, size, maximumBytes, limitName);
        if (!parentMetered) {
          if (limitName === NATIVE_STRUCTURE_LIMIT) this.#reserveWork(size);
          else this.#budgetWork(size);
        }
        return source.readBounded !== undefined
          ? source.readBounded(
              row.location.offset + offset,
              size,
              maximumBytes,
              limitName,
            )
          : source.read(row.location.offset + offset, size);
      },
    };
    this.#meteredSources.add(child);

    try {
      // An AMD target declaration does not establish an ELF representation.
      // Without an outer target, inventory must still avoid an ELF corruption
      // claim for recognizable bitcode; its inner target remains unexamined.
      if (
        directory === undefined &&
        isLlvmBitcode(await child.read(0, Math.min(4, child.size)))
      ) {
        this.discovery = "partial";
        if (this.input.analysis !== "kernels" || !this.#selected(row))
          this.#objectLimitations(row, [LLVM_BITCODE_LIMITATION]);
        await this.#payload(source, row);
        return;
      }
      const native =
        directory ??
        (await readGpuNativeDirectory(
          child,
          readElfSectionDirectory(
            child.size,
            this.#budgets.maxStructureBytes === undefined
              ? undefined
              : { structureBytes: this.#budgets.maxStructureBytes },
          ),
          () => yieldArtifactRead(this.signal),
          this.#budgets.maxStructureBytes,
        ));
      const inspected = await readAmdElfMetadata(child, native, this.#budgets);
      const prepared = inspected.ok ? inspected.value : inspected.error.partial;
      if (prepared.limitations.length > 0) this.discovery = "partial";
      this.#target(row, {
        value: prepared.target,
        identity: prepared.targetIdentity,
        amdMetadata: prepared.targetMetadata,
        scope: "amdgpu",
      });
      if (!inspected.ok) {
        this.discovery = "partial";
        if (this.input.analysis === "kernels" && this.#selected(row))
          await this.#elfFacts(child, row, "amdgpu", prepared);
        else this.#objectLimitations(row, prepared.limitations);
        this.#retainFailure(row, inspected.error.cause);
        return;
      }
      const payloadSelected =
        this.input.analysis === "kernels" && this.#selected(row);
      await this.#payload(source, row, { amdMetadata: prepared });
      if (!payloadSelected && prepared.limitations.length > 0)
        this.#objectLimitations(row, prepared.limitations);
    } catch (cause) {
      this.discovery = "partial";
      this.#retainFailure(row, cause);
    }
  }
  async #elfFacts(
    source: GpuSource,
    row: GpuObject,
    kind: "cubin" | "amdgpu",
    preparedAmd?: AmdElfMetadata,
  ): Promise<"complete" | "partial"> {
    let conflict: string | undefined;
    const parsed = await readGpuElfKernels(
      source,
      kind,
      (kernel) => {
        if (conflict !== undefined) kernel.limitations.push(conflict);
        this.#retain(kernel);
        this.kernels.push(kernel);
      },
      () => yieldArtifactRead(this.signal),
      preparedAmd,
      (target) => {
        conflict = this.#target(row, target);
      },
      this.#budgets,
    );
    this.#objectLimitations(row, parsed.limitations);
    return conflict !== undefined ? "partial" : parsed.coverage;
  }
  async #cuda(source: GpuSource): Promise<void> {
    for await (const { row, declaredDecodedSize } of readCudaFatbinary(
      source,
      this.signal,
    )) {
      this.#add(row);
      await this.#payload(source, row, { declaredDecodedSize });
    }
  }
  async #hip(source: GpuSource, depth: number): Promise<void> {
    let base = 0;
    let bundles = 0;
    let legacyWindow: { offset: number; bytes: Buffer } | undefined;
    while (base < source.size) {
      if (++bundles % 128 === 0) {
        await scheduler.yield();
        assertArtifactReadActive(this.signal);
      }
      const prefix = await source.read(base, Math.min(32, source.size - base));
      if (prefix.subarray(0, 24).equals(CLANG_BUNDLE_MAGIC)) {
        const directory = await readClangBundleDirectory(
          source,
          base,
          this.signal,
          this.#budgets,
        );
        for (const { object: row, amdTarget } of directory.declarations) {
          this.#add(row, amdTarget);
          if (row.kind === "host") row.inspection = "complete";
          else if (row.kind === "amdgpu" && row.target === null)
            await this.#amdPayload(source, row);
          else await this.#payload(source, row);
        }
        base = await nextGpuContainerOffset(source, directory.end, this.signal);
        continue;
      }
      if (!prefix.subarray(0, CCOB_MAGIC.length).equals(CCOB_MAGIC))
        rejectGpu("Unexpected bytes between Clang offload bundles");
      const header = readCcobHeader(prefix, source.size - base),
        { width, decoded: declaredDecodedSize, hash, version, method } = header;
      let total = header.total;
      let extentKnown = version !== 1;
      const row = gpuObject(source, {
        offset: base + width,
        size: total - width,
        kind: "hip-bundle",
        metadata: { offset: base, size: width },
      });
      row.compression =
        method === 0 ? "zlib" : method === 1 ? "zstd" : "unsupported";
      row.compression_id = `ccob:${version}:${method}`;
      recordDeclaredGpuDecodedSize(row, declaredDecodedSize);
      if (extentKnown) this.#add(row);
      if (row.compression === "unsupported") {
        row.inspection = "unsupported";
        this.#objectLimitations(row, ["Unsupported CCOB compression method"]);
        this.discovery = "partial";
      } else
        try {
          // v1 has no encoded size. Supply a bounded suffix, then retain only
          // the codec's completed extent, never an embedded CCOB marker.
          const inputSize =
            version === 1
              ? Math.min(total - width, this.#budgets.maxObjectBytes)
              : total - width;
          let data: Buffer;
          if (version === 1) {
            const start = base + width;
            const cached =
              legacyWindow !== undefined &&
              start >= legacyWindow.offset &&
              start < legacyWindow.offset + legacyWindow.bytes.length;
            const readWindow = async (
              chargeDecoded: boolean,
            ): Promise<Buffer> => {
              if (chargeDecoded)
                this.#reserveReadWork(source, inputSize, declaredDecodedSize);
              else this.#reserveReadWork(source, inputSize);
              legacyWindow = undefined;
              const bytes = await source.read(start, inputSize);
              legacyWindow = { offset: start, bytes };
              return bytes;
            };
            if (cached) this.#budgetWork(declaredDecodedSize);
            let encoded: Buffer | undefined = cached
              ? legacyWindow!.bytes.subarray(start - legacyWindow!.offset)
              : await readWindow(true);
            const decoded = Number(declaredDecodedSize);
            const available = encoded.length;
            const compression = row.compression;
            const ccobWindowLimit = (): BinaryResourceFailure =>
              new BinaryResourceFailure(
                "structure",
                this.#budgets.maxObjectBytes,
                `Legacy CCOB v1 compressed payload exceeds the ${String(this.#budgets.maxObjectBytes)}-byte object budget`,
                GPU_OBJECT_BYTES_LIMIT,
                "bytes",
              );
            const decodeRefilledWindow = async (): Promise<{
              buffer: Buffer;
              consumedBytes: number;
              inputExhausted: boolean;
              frameAllowanceReached?: ZstandardFrameAllowance;
            }> => {
              // Retire the previous window before allocating its replacement.
              // `declaredDecodedSize` was already reserved when the cached path began.
              encoded = undefined;
              const refilled = await readWindow(false);
              encoded = refilled;
              return decodeGpuPayloadStream(
                refilled,
                compression,
                decoded,
                this.signal,
              ).catch((refillCause: unknown) => {
                if (
                  isTruncatedGpuPayloadFailure(refillCause) &&
                  total - width > this.#budgets.maxObjectBytes
                )
                  throw ccobWindowLimit();
                throw refillCause;
              });
            };
            let refilled = false;
            let completed:
              | {
                  buffer: Buffer;
                  consumedBytes: number;
                  inputExhausted: boolean;
                  frameAllowanceReached?: ZstandardFrameAllowance;
                }
              | undefined = await decodeGpuPayloadStream(
              encoded,
              compression,
              decoded,
              this.signal,
            ).catch(async (cause: unknown) => {
              // A cached window may end inside this sibling. Refill once
              // before treating that incomplete view as a truncated stream.
              if (
                isTruncatedGpuPayloadFailure(cause) &&
                cached &&
                available < inputSize
              ) {
                refilled = true;
                return decodeRefilledWindow();
              }
              if (
                isTruncatedGpuPayloadFailure(cause) &&
                total - width > this.#budgets.maxObjectBytes
              )
                throw ccobWindowLimit();
              throw cause;
            });
            // When the decoder stopped because the supplied window ran out at a
            // frame boundary or partial next-frame magic (including before a
            // trailing skippable or empty Zstandard frame), peek 4 bytes past the
            // consumed extent to confirm another Zstandard/skippable frame actually
            // follows before reporting zstd.max_frames, refilling, or reporting capacity.
            const hasFollowingZstandardFrame = async (
              consumedBytes: number,
            ): Promise<boolean> => {
              if (total - width - consumedBytes < ZSTANDARD_MAGIC_BYTES)
                return false;
              const peek = await source.read(
                start + consumedBytes,
                ZSTANDARD_MAGIC_BYTES,
              );
              return zstandardFrameKind(peek, 0) !== undefined;
            };
            if (
              completed.inputExhausted &&
              (await hasFollowingZstandardFrame(completed.consumedBytes))
            ) {
              if (completed.frameAllowanceReached !== undefined)
                throw new ZstandardFrameAllowanceError(
                  completed.frameAllowanceReached,
                  completed.consumedBytes,
                );
              if (!refilled && cached && available < inputSize) {
                // Release the partial decode output before allocating a refilled window.
                completed = undefined;
                refilled = true;
                completed = await decodeRefilledWindow();
                if (
                  completed.inputExhausted &&
                  (await hasFollowingZstandardFrame(completed.consumedBytes))
                ) {
                  if (completed.frameAllowanceReached !== undefined)
                    throw new ZstandardFrameAllowanceError(
                      completed.frameAllowanceReached,
                      completed.consumedBytes,
                    );
                  if (total - width > this.#budgets.maxObjectBytes)
                    throw ccobWindowLimit();
                }
              } else if (total - width > this.#budgets.maxObjectBytes) {
                throw ccobWindowLimit();
              }
            }
            total = width + completed.consumedBytes;
            extentKnown = true;
            this.#encodedExtent(row, completed.consumedBytes);
            // Publish the completed parent extent before inspecting its children.
            this.#add(row);
            data = completed.buffer;
            if (data.length !== decoded)
              rejectGpu(
                "GPU decompressed length disagrees with its declaration",
              );
          } else {
            this.#reserveReadWork(source, inputSize, declaredDecodedSize);
            data = await decodeGpuPayload(
              await source.read(base + width, inputSize),
              row.compression,
              Number(declaredDecodedSize),
              this.signal,
              this.#budgets.maxObjectBytes,
            );
          }
          if (
            new BinaryReader(
              createHash("md5").update(data).digest(),
              true,
              "ccob",
            ).word(0, 64) !== hash
          )
            rejectGpu("CCOB truncated MD5 does not match decoded bytes");
          this.#decoded(row, sha256Hex(data), data.length);
          await this.inspect(
            new GpuBufferSource(data, row.id, this.#budgets.maxObjectBytes),
            depth + 1,
          );
          row.inspection = "complete";
        } catch (cause) {
          this.#retainFailure(row, cause);
          this.discovery = "partial";
        }
      if (!extentKnown) {
        if (row.inspection !== "capacity")
          try {
            total = await findLegacyCcobRecoveryTotal(
              source,
              base,
              this.#budgets.maxObjectBytes,
            );
          } catch (cause) {
            if (!(cause instanceof BinaryResourceFailure)) throw cause;
            this.#retainFailure(row, cause);
          }
        // A capacity refusal cannot establish a boundary for later siblings.
        if (row.inspection === "capacity") {
          this.#objectLimitations(row, [
            "CCOB v1 codec extent is unknown; the retained size is only the containing tail, not a completed codec extent. Later siblings were not inferred.",
          ]);
          this.#add(row);
          return;
        }
        this.#encodedExtent(row, total - width);
        this.#objectLimitations(row, [
          total < source.size - base
            ? "CCOB v1 codec extent is unknown; the next CCOB marker is only an uncertain recovery candidate."
            : "CCOB v1 codec extent is unknown; the retained range extends to the container end.",
        ]);
        this.#add(row);
      }
      base = await nextGpuContainerOffset(source, base + total, this.signal);
    }
  }
}
const LLVM_BITCODE_LIMITATION =
  "LLVM bitcode kernel metadata is outside current coverage; bitcode validity and inner target were not inspected.";
const gpuCapacityLimitationMessage = (cause: BinaryResourceFailure): string => {
  const parameter = gpuBudgetParameterForLimit(cause.failure.limit.name);
  return parameter === undefined
    ? cause.message
    : `${cause.message} (parameter: ${parameter})`;
};
/** LLVM raw and wrapper signatures identify representation, not bitcode validity. */
const isLlvmBitcode = (bytes: Buffer): boolean => {
  if (bytes.length < 4) return false;
  const magic = new BinaryReader(bytes, true, "llvm-bitcode").u32(0);
  return magic === 0xdec04342 || magic === 0x0b17c0de;
};
const isGpuSection = (name: string): boolean =>
  [
    ".nv_fatbin",
    ".nv_fatb",
    ".hip_fatbin",
    ".hip_fat",
    ".llvm.offloading",
  ].includes(name);
