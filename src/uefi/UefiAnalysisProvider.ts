import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
  type ProviderAvailability,
} from "../application/AnalysisProvider.js";
import type { UefiAnalysisPort } from "../application/uefi/UefiAnalysisPort.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { digestSchema } from "../domain/digests.js";
import type { Result } from "../domain/result.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import {
  uefiResultSchemas,
  type UefiExtractResult,
  type UefiFfsFileRecord,
  type UefiInspectResult,
  type UefiNvramInspectResult,
  type UefiSectionRecord,
  type UefiVolumeRecord,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import type { UefiRequest } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type {
  UefiImageScanSummary,
  UefiLzmaDecodeOutcome,
  UefiLzmaDecodeRequest,
} from "./UefiImageScan.js";
import { scanUefiImage } from "./UefiImageScan.js";
import { scanAmiNvramStores } from "./UefiNvram.js";
import { AMD_ZLIB_HEADER_LENGTH, peelAmiZlibPayload } from "./FfsSections.js";
import { uefiFailure } from "./UefiFailures.js";
import {
  publishUefiFiles,
  type UefiPublicationEntry,
} from "./UefiPublication.js";

export const UEFI_PROVIDER_IDENTITY = {
  id: "rea-uefi",
  name: "REA UEFI firmware parser",
  version: "1.0.0",
} as const;

/** Mirror of the owned worker's reply contract; parsed before use. */
const lzmaReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    lzma_version: z.string(),
    output: z.strictObject({
      sha256: digestSchema,
      bytes: z.number().int().min(0),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["format", "decoder", "output-limit"]),
    message: z.string(),
  }),
]);

type UefiLzmaWorkerDecode =
  | { readonly ok: true; readonly outcome: UefiLzmaDecodeOutcome }
  | { readonly ok: false; readonly message: string };

const SECTION_TYPE_FIRMWARE_VOLUME_IMAGE = 0x17;
const FFS_FILE_TYPE_PAD = 0xf0;

const hex = (value: number): string => `0x${value.toString(16)}`;

const targetInputError = (message: string): AnalysisInputError =>
  new AnalysisInputError("extract_uefi_firmware", { cause: undefined }, [
    { path: ["target"], reason: "invalid_value", message },
  ]);

/** One staged extraction payload plus the metadata the result schema needs. */
interface PlannedExtraction {
  readonly entry: UefiPublicationEntry;
  readonly source: UefiExtractResult["files"][number]["source"];
  readonly originalFileRange: {
    readonly offset: number;
    readonly length: number;
  };
  readonly parentLogicalPath: string | null;
}

/**
 * Selected FFS files plus an optional only-this-section restriction. Every
 * entry names its owning volume, because extraction carves from that volume's
 * byte context (the flash image, or a decoded stream for nested volumes).
 */
interface UefiSelection {
  readonly offset: number;
  readonly length: number;
  readonly files: readonly {
    readonly file: UefiFfsFileRecord;
    readonly volume: UefiVolumeRecord;
    readonly sectionOnly: UefiSectionRecord | null;
  }[];
}

/**
 * Byte context that a scanned record's offsets resolve against. Offsets are
 * image-absolute for image-backed volumes and anchored at the compressed
 * stream's position inside the parent context for decoded-stream volumes
 * (UefiImageScan records the same anchor). The scan never stores record
 * offsets outside the context it carved them from, so carving is always
 * `record.offset − context.origin` inside `context.buffer`.
 */
type ResolvedContext =
  | { readonly kind: "image"; readonly buffer: Buffer }
  | {
      readonly kind: "decoded";
      readonly buffer: Buffer;
      readonly origin: number;
    };

const localOffset = (context: ResolvedContext, recordOffset: number): number =>
  context.kind === "image" ? recordOffset : recordOffset - context.origin;

/**
 * Locate the file record that spawned one nested volume: FFI-section volumes
 * link through their owning section's sub_volumes list, while raw-file
 * embedded volumes (AMI ROM holes) hang directly under the file path. The
 * offset match plus membership prefix guards against accidental collisions
 * between anchored coordinate spaces.
 */
const owningOf = (
  scan: UefiImageScanSummary,
  volume: UefiVolumeRecord,
): {
  readonly parent: UefiVolumeRecord;
  readonly file: UefiFfsFileRecord;
  readonly section: UefiSectionRecord | null;
} | null => {
  if (volume.parent_offset === null) return null;
  const owns = (file: UefiFfsFileRecord): boolean =>
    file.sections.some((section) =>
      section.sub_volumes.includes(volume.logical_path),
    ) || volume.logical_path.startsWith(`${file.logical_path}/embedded/`);
  const parent = scan.volumes.find(
    (candidate) =>
      candidate.offset === volume.parent_offset &&
      candidate.ffs_files.some(owns),
  );
  const file = parent?.ffs_files.find(owns);
  if (parent === undefined || file === undefined) return null;
  return {
    parent,
    file,
    section:
      file.sections.find((section) =>
        section.sub_volumes.includes(volume.logical_path),
      ) ?? null,
  };
};

/** Resolve the requested extraction scope against the scanned volume tree. */
const selectTargets = (
  scan: UefiImageScanSummary,
  target:
    | { readonly kind: "whole-image" }
    | { readonly kind: "volume"; readonly offset: number }
    | { readonly kind: "ffs-file"; readonly offset: number }
    | { readonly kind: "section"; readonly offset: number },
): UefiSelection => {
  const fileEntryOf = (
    file: UefiFfsFileRecord,
    volume: UefiVolumeRecord,
    sectionOnly: UefiSectionRecord | null = null,
  ) => ({ file, volume, sectionOnly });
  const missing = (subject: string): AnalysisInputError =>
    targetInputError(
      `No scanned ${subject} at offset ${hex("offset" in target ? target.offset : 0)}; offsets must match a mapped volume, FFS file or section record.`,
    );
  switch (target.kind) {
    case "whole-image":
      return {
        offset: 0,
        length: scan.inputSize,
        files: scan.volumes.flatMap((volume) =>
          volume.ffs_files.map((file) => fileEntryOf(file, volume)),
        ),
      };
    case "volume": {
      const volume = scan.volumes.find(
        (candidate) => candidate.offset === target.offset,
      );
      if (volume === undefined) throw missing("firmware volume");
      return {
        offset: volume.offset,
        length: volume.length,
        files: volume.ffs_files.map((file) => fileEntryOf(file, volume)),
      };
    }
    case "ffs-file": {
      for (const volume of scan.volumes) {
        const file = volume.ffs_files.find(
          (candidate) => candidate.offset === target.offset,
        );
        if (file !== undefined)
          return {
            offset: file.offset,
            length: file.length,
            files: [fileEntryOf(file, volume)],
          };
      }
      throw missing("FFS file");
    }
    case "section": {
      for (const volume of scan.volumes) {
        for (const file of volume.ffs_files) {
          const section = file.sections.find(
            (candidate) => candidate.offset === target.offset,
          );
          if (section !== undefined)
            return {
              offset: section.offset,
              length: section.length,
              files: [fileEntryOf(file, volume, section)],
            };
        }
      }
      throw missing("FFS section");
    }
  }
};

/**
 * Pure TypeScript UEFI provider: static flash-image cartography plus budgeted
 * extraction. LZMA payloads decode through one owned, freshly spawned node
 * worker per stream; budgets are enforced by the worker reply contract. No
 * prlimit wrapper and no external tools are involved.
 */
export class UefiAnalysisProvider implements UefiAnalysisPort {
  #closing = false;
  #tail: Promise<void> = Promise.resolve();
  readonly #resources = new ArtifactResourceScope();
  readonly #workerModulePath: string;

  constructor(
    workerModulePath: string = fileURLToPath(
      new URL("./UefiLzmaWorker.js", import.meta.url),
    ),
  ) {
    this.#workerModulePath = workerModulePath;
  }

  async inspectAvailability(): Promise<ProviderAvailability> {
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        decoder: "lzma-purejs (owned worker)",
        external_tools: "none",
      },
    };
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#tail.catch(() => undefined);
    await this.#resources.close();
  }

  async execute(
    request: UefiRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing) {
      return {
        ok: false,
        error: new AnalysisInputError(request.operation, { cause: undefined }, [
          {
            path: [],
            reason: "invalid_value",
            message: "rea-uefi provider is closed; construct a new provider.",
          },
        ]),
      };
    }
    // Admit one operation at a time so the advertised single decode-worker lane
    // cannot become one worker per overlapping call.
    return this.#serialize(() => this.#executeWithDeadline(request, options));
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Bound the whole request with one deadline, including every decode stage. */
  async #executeWithDeadline(
    request: UefiRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `UEFI operation exceeded the ${UEFI_FIRMWARE_LIMITS.timeoutMs} ms deadline.`,
          ),
        ),
      UEFI_FIRMWARE_LIMITS.timeoutMs,
    );
    const parent = options?.signal;
    const onParentAbort = () => controller.abort(parent?.reason);
    if (parent !== undefined) {
      if (parent.aborted) controller.abort(parent.reason);
      else parent.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      return await this.#executeWithSignal(request, controller.signal);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }

  async #executeWithSignal(
    request: UefiRequest,
    signal: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    return this.#resources.run(async () => {
      try {
        const snapshot = await readStableArtifact(
          request.input.path,
          UEFI_FIRMWARE_LIMITS.inputBytes,
          signal,
          undefined,
          this.#resources,
        );
        if (request.operation === "inspect_uefi_nvram") {
          return {
            ok: true,
            value: this.#inspectNvram(request, snapshot.sha256, snapshot.bytes),
          };
        }
        const scan = await scanUefiImage(
          snapshot.bytes,
          request.operation === "inspect_uefi_firmware"
            ? {
                maxDepth: request.input.max_depth,
                maxVolumes: request.input.max_volumes,
                maxFiles: request.input.max_files,
              }
            : {
                maxDepth: request.input.max_depth,
                maxVolumes: UEFI_FIRMWARE_LIMITS.defaultMaxVolumes,
                maxFiles: UEFI_FIRMWARE_LIMITS.defaultMaxFiles,
              },
          (laneRequest: UefiLzmaDecodeRequest) =>
            this.#decodeStream(
              laneRequest.payload,
              laneRequest.format,
              signal,
            ).then((decoded) => (decoded.ok ? decoded.outcome : null)),
        );
        return {
          ok: true,
          value:
            request.operation === "inspect_uefi_firmware"
              ? this.#inspect(request, snapshot.sha256, scan)
              : await this.#extract(
                  request,
                  snapshot.bytes,
                  snapshot.sha256,
                  scan,
                  signal,
                ),
        };
      } catch (cause: unknown) {
        return {
          ok: false,
          error: uefiFailure(cause, request.operation, request.input.path),
        };
      }
    });
  }

  #inspect(
    request: Extract<UefiRequest, { operation: "inspect_uefi_firmware" }>,
    imageSha256: string,
    scan: UefiImageScanSummary,
  ): AnalysisExecution {
    const firstVolume = scan.volumes[0];
    const entryBasis =
      firstVolume === undefined
        ? ("unknown" as const)
        : firstVolume.offset === 0
          ? ("fv-at-zero" as const)
          : scan.pspTables.length > 0
            ? ("amd-psp-first" as const)
            : ("scanned" as const);
    const result: UefiInspectResult =
      uefiResultSchemas.inspect_uefi_firmware.parse({
        parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
        input_size: scan.inputSize,
        flash_image: {
          sha256: imageSha256,
          size: scan.inputSize,
          entry_basis: entryBasis,
        },
        firmware_volumes: scan.volumes,
        psp_tables: scan.pspTables.map((table) => ({
          offset: table.offset,
          length: table.length,
          table_magic: table.tableMagic,
          total_entries: table.totalEntries,
          entries: table.entries.map((entry) => ({
            type: entry.type,
            declared_location: entry.declaredLocation,
            declared_size: entry.declaredSize,
            image_offset: entry.imageOffset,
            sha256: entry.sha256,
            location_basis: entry.locationBasis,
          })),
          entry_stride_basis: table.entryStrideBasis,
        })),
        psp_candidates: scan.pspCandidates,
        unknown_regions: scan.unknownRegions,
        integrity: scan.integrity,
        coverage:
          scan.budgetExhausted || scan.truncationObserved
            ? "partial"
            : "complete",
        limitations: [...scan.limitations],
      });
    return createAnalysisExecution(result, UEFI_PROVIDER_IDENTITY, {
      subject: {
        path: request.input.path,
        sha256: imageSha256,
        format: "file",
      },
      locations: [{ kind: "artifact-path", path: request.input.path }],
      limitations: [
        ...scan.limitations,
        "Static cartography only; no executable code is loaded or emulated.",
      ],
    });
  }

  /** AMI NVRAM stores are parsed from the raw image; no firmware-volume walk needed. */
  #inspectNvram(
    request: Extract<UefiRequest, { operation: "inspect_uefi_nvram" }>,
    imageSha256: string,
    image: Buffer,
  ): AnalysisExecution {
    const scan = scanAmiNvramStores(
      image,
      request.input.max_stores,
      request.input.max_depth,
    );
    const result: UefiNvramInspectResult =
      uefiResultSchemas.inspect_uefi_nvram.parse({
        parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
        input_size: image.length,
        image_sha256: imageSha256,
        stores: scan.stores.map((store) => ({
          offset: store.offset,
          name: store.name,
          variables: store.variables.map((variable) => ({
            offset: variable.offset,
            name: variable.name,
            attributes: variable.attributes,
            state: variable.state,
            depth: variable.depth,
            parent_offset: variable.parentOffset,
            data_offset: variable.dataOffset,
            data_length: variable.dataLength,
            data_sha256: createHash("sha256")
              .update(
                image.subarray(
                  variable.dataOffset,
                  variable.dataOffset + variable.dataLength,
                ),
              )
              .digest("hex"),
          })),
          trailing_padding: store.trailingPadding,
        })),
        coverage: scan.coverage,
        limitations: [...scan.limitations],
      });
    return createAnalysisExecution(result, UEFI_PROVIDER_IDENTITY, {
      subject: {
        path: request.input.path,
        sha256: imageSha256,
        format: "file",
      },
      locations: [{ kind: "artifact-path", path: request.input.path }],
      limitations: [
        ...scan.limitations,
        "Static AMI NVRAM parsing only; variable bytes are reported, never interpreted or executed.",
      ],
    });
  }

  async #extract(
    request: Extract<UefiRequest, { operation: "extract_uefi_firmware" }>,
    image: Buffer,
    imageSha256: string,
    scan: UefiImageScanSummary,
    signal?: AbortSignal,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const selection = selectTargets(scan, input.target);
    const gaps: UefiExtractResult["extraction_gaps"] = [];
    const derivations: UefiExtractResult["derivations"] = [];
    const plan: PlannedExtraction[] = [];
    let stagedBytes = 0;
    let decodeAttempts = 0;
    let decodeSuccesses = 0;
    const carve = (
      context: ResolvedContext,
      offset: number,
      length: number,
      subject: string,
    ): Buffer => {
      const start = localOffset(context, offset);
      if (
        offset < 0 ||
        length < 0 ||
        start < 0 ||
        start + length > context.buffer.length
      ) {
        throw targetInputError(
          `Planned ${subject} carve ${hex(offset)}..${hex(offset + length)} leaves the ${context.buffer.length}-byte ${context.kind === "image" ? "flash image" : "decoded stream"}.`,
        );
      }
      return context.buffer.subarray(start, start + length);
    };
    const stage = (
      relativePath: string,
      bytes: Buffer,
      source: PlannedExtraction["source"],
      originalFileRange: PlannedExtraction["originalFileRange"],
      parentLogicalPath: string | null,
    ): void => {
      if (bytes.length === 0) return;
      if (plan.length >= input.max_output_files) {
        gaps.push({
          kind: "size-truncated",
          logical_path: parentLogicalPath ?? "flash",
          range: originalFileRange,
          detail: `max_output_files ${input.max_output_files} reached; ${relativePath} not extracted.`,
        });
        return;
      }
      if (stagedBytes + bytes.length > input.max_output_bytes) {
        gaps.push({
          kind: "size-truncated",
          logical_path: parentLogicalPath ?? "flash",
          range: originalFileRange,
          detail: `max_output_bytes ${input.max_output_bytes} reached; ${relativePath} (${bytes.length} bytes) not extracted.`,
        });
        return;
      }
      stagedBytes += bytes.length;
      plan.push({
        entry: { relativePath, bytes },
        source,
        originalFileRange,
        parentLogicalPath,
      });
    };
    /** Decoded byte context per owning-section locator, so nested volumes and
     * the owning file's walk share one decode; null marks failed decodes. */
    const decodedContexts = new Map<string, ResolvedContext | null>();
    const volumeContexts = new Map<string, ResolvedContext | null>();

    /**
     * Decode one compressed guided section inside its parent context, stage
     * the decoded stream, and return the byte context that the stream's
     * nested volumes carve from. The stream anchor mirrors UefiImageScan: the
     * decompressed bytes sit behind the compressed payload start (after the
     * AMI-zlib header when present).
     */
    const stageDecodedSection = async (
      file: UefiFfsFileRecord,
      section: UefiSectionRecord,
      parentContext: ResolvedContext,
    ): Promise<ResolvedContext | null> => {
      signal?.throwIfAborted();
      const locator = `${file.logical_path}/section-${hex(section.offset)}`;
      const cached = decodedContexts.get(locator);
      if (cached !== undefined) return cached;
      const compression = section.compression;
      if (compression.kind === "none") {
        decodedContexts.set(locator, null);
        return null;
      }
      const format =
        compression.kind === "ami-zlib" ? ("zlib" as const) : ("lzma" as const);
      const compressedOffset = section.offset + compression.data_offset;
      const compressedLength = section.length - compression.data_offset;
      const compressedRange = {
        offset: compressedOffset,
        length: compressedLength,
      };
      let resolved: ResolvedContext | null = null;
      let carrier: Buffer | null = null;
      if (compressedLength <= 0) {
        gaps.push({
          kind: "unsupported-compression",
          logical_path: locator,
          range: null,
          detail: `${section.compression.kind} section at ${hex(section.offset)} declares no compressed payload to decode.`,
        });
      } else {
        carrier = carve(
          parentContext,
          compressedOffset,
          compressedLength,
          "compressed section",
        );
        let stream: Buffer | null = carrier;
        if (format === "zlib") {
          const peeled = peelAmiZlibPayload(carrier);
          if (peeled == null) {
            gaps.push({
              kind: "unsupported-compression",
              logical_path: locator,
              range: compressedRange,
              detail: `AMI-zlib payload at ${hex(compressedOffset)} is shorter than the ${hex(AMD_ZLIB_HEADER_LENGTH)}-byte AMD section header; no stream to decode.`,
            });
            stream = null;
          } else {
            stream = peeled.stream;
          }
        }
        if (stream != null) {
          decodeAttempts += 1;
          const outcome = await this.#decodeStream(stream, format, signal);
          if (outcome.ok) {
            decodeSuccesses += 1;
            stagedDecoded(
              locator,
              outcome,
              compressedRange,
              file.logical_path,
              format,
            );
            resolved = {
              kind: "decoded",
              buffer: outcome.outcome.bytes,
              origin:
                localOffset(parentContext, section.offset) +
                compression.data_offset,
            };
          } else {
            gaps.push({
              kind: "unsupported-compression",
              logical_path: locator,
              range: compressedRange,
              detail: `${format === "zlib" ? "zlib" : "LZMA"} decode failed: ${outcome.message}`,
            });
          }
        }
      }
      if (resolved === null && carrier !== null && input.include_compressed) {
        stage(
          `${locator}.compressed.bin`,
          carrier,
          "compressed-passthrough",
          compressedRange,
          file.logical_path,
        );
      }
      decodedContexts.set(locator, resolved);
      return resolved;
    };

    /** Resolve the byte context of any scanned volume, decoding owning
     * compressed sections on demand; null volumes keep their files uncarved. */
    const contextForVolume = async (
      volume: UefiVolumeRecord,
    ): Promise<ResolvedContext | null> => {
      const cached = volumeContexts.get(volume.logical_path);
      if (cached !== undefined) return cached;
      let resolved: ResolvedContext | null;
      if (volume.parent_offset === null) {
        resolved = { kind: "image", buffer: image };
      } else {
        const owner = owningOf(scan, volume);
        if (owner === null) {
          gaps.push({
            kind: "unsupported-compression",
            logical_path: volume.logical_path,
            range: { offset: volume.offset, length: volume.length },
            detail: `Owning file context for ${volume.logical_path} is not resolvable; its files stay uncarved.`,
          });
          resolved = null;
        } else {
          const parentContext = await contextForVolume(owner.parent);
          const ownerSection = owner.section;
          resolved =
            parentContext === null
              ? null
              : ownerSection === null ||
                  ownerSection.compression.kind === "none"
                ? parentContext
                : await stageDecodedSection(
                    owner.file,
                    ownerSection,
                    parentContext,
                  );
        }
      }
      volumeContexts.set(volume.logical_path, resolved);
      return resolved;
    };
    const stagedDecoded = (
      locator: string,
      outcome: { ok: true; outcome: UefiLzmaDecodeOutcome },
      compressedRange: { offset: number; length: number },
      parentLogicalPath: string | null,
      format: "lzma" | "zlib" = "lzma",
    ): void => {
      const decodedPath = `${locator}.decoded.bin`;
      const before = stagedBytes;
      stage(
        decodedPath,
        outcome.outcome.bytes,
        format === "zlib" ? "decompressed-zlib" : "decompressed-lzma",
        compressedRange,
        parentLogicalPath,
      );
      if (stagedBytes > before) {
        derivations.push({
          parent_path: locator,
          child_path: decodedPath,
          parent_file_range: compressedRange,
          handler:
            format === "zlib"
              ? `node-zlib@${outcome.outcome.decoderVersion}`
              : `lzma-purejs@${outcome.outcome.decoderVersion}`,
        });
      }
    };
    for (const { file, volume, sectionOnly } of selection.files) {
      signal?.throwIfAborted();
      const context = await contextForVolume(volume);
      if (context === null) continue;
      if (file.type_code === FFS_FILE_TYPE_PAD) {
        gaps.push({
          kind: "pad-file",
          logical_path: file.logical_path,
          range: { offset: file.offset, length: file.length },
          detail: `Pad file at ${hex(file.offset)} stays in place; only its extent is reported.`,
        });
        continue;
      }
      if (file.sections.length === 0) {
        const bodyRange = {
          offset: file.offset + file.header_length,
          length: Math.max(0, file.length - file.header_length),
        };
        stage(
          `${file.logical_path}.body.bin`,
          carve(context, bodyRange.offset, bodyRange.length, "raw file body"),
          "uncompressed-payload",
          bodyRange,
          null,
        );
        continue;
      }
      for (const section of sectionOnly === null
        ? file.sections
        : [sectionOnly]) {
        if (
          section.type_code === SECTION_TYPE_FIRMWARE_VOLUME_IMAGE &&
          section.sub_volumes.length > 0 &&
          sectionOnly === null
        ) {
          continue;
        }
        if (section.compression.kind === "none") {
          const payloadRange = {
            offset: section.offset + section.header_length,
            length: Math.max(0, section.length - section.header_length),
          };
          stage(
            `${file.logical_path}/section-${hex(section.offset)}.payload.bin`,
            carve(
              context,
              payloadRange.offset,
              payloadRange.length,
              "section payload",
            ),
            "raw-section",
            payloadRange,
            file.logical_path,
          );
          continue;
        }
        if (
          section.compression.kind === "lzma-custom" ||
          section.compression.kind === "lzmaf86" ||
          section.compression.kind === "ami-zlib"
        ) {
          await stageDecodedSection(file, section, context);
          continue;
        }
        const compressedOffset =
          section.offset + section.compression.data_offset;
        const compressedLength =
          section.length - section.compression.data_offset;
        const locator = `${file.logical_path}/section-${hex(section.offset)}`;
        gaps.push({
          kind:
            section.compression.kind === "unknown-guid"
              ? "unknown-guid-handler"
              : "unsupported-compression",
          logical_path: locator,
          range:
            compressedLength > 0
              ? { offset: compressedOffset, length: compressedLength }
              : null,
          detail: `${section.compression.kind} payload at ${hex(compressedOffset)} is recognized but has no decoder; ${input.include_compressed ? "publishing the raw carrier" : "carrier not requested (include_compressed=false)"}.`,
        });
        if (input.include_compressed && compressedLength > 0) {
          stage(
            `${locator}.compressed.bin`,
            carve(
              context,
              compressedOffset,
              compressedLength,
              "compressed section",
            ),
            "compressed-passthrough",
            { offset: compressedOffset, length: compressedLength },
            file.logical_path,
          );
        }
      }
    }
    const publication = await publishUefiFiles({
      outputDirectory: input.output_directory,
      operation: request.operation,
      entries: plan.map((planned) => planned.entry),
      ...(signal === undefined ? {} : { signal }),
    });
    const result: UefiExtractResult =
      uefiResultSchemas.extract_uefi_firmware.parse({
        parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
        selection: {
          offset: selection.offset,
          length: selection.length,
          target_kind: input.target.kind,
        },
        output_directory: publication.outputRoot,
        coverage:
          gaps.some((gap) => gap.kind !== "pad-file") ||
          scan.budgetExhausted ||
          scan.truncationObserved
            ? "partial"
            : "complete",
        files: plan.map((planned, index) => {
          const published = publication.files[index];
          if (published === undefined) {
            throw new Error(
              `Publication outcome lost ${planned.entry.relativePath}.`,
            );
          }
          return {
            relative_path: planned.entry.relativePath,
            path: published.path,
            size: published.size,
            sha256: published.sha256,
            original_file_range: planned.originalFileRange,
            runtime_address: null,
            media_type: null,
            source: planned.source,
            parent_logical_path: planned.parentLogicalPath,
          };
        }),
        derivations,
        extraction_gaps: gaps,
        diagnostics: `${scan.volumes.length} volumes mapped, ${selection.files.length} files selected; ${decodeAttempts} decode attempt(s), ${decodeSuccesses} result(s); ${gaps.length} gap(s); staged ${plan.length} file(s), ${stagedBytes} bytes.`,
        published_bytes: stagedBytes,
      });
    return createAnalysisExecution(result, UEFI_PROVIDER_IDENTITY, {
      subject: {
        path: input.path,
        sha256: imageSha256,
        format: "file",
      },
      locations: [{ kind: "artifact-path", path: input.path }],
      limitations: scan.limitations,
    });
  }

  /**
   * Decode one compressed stream. LZMA variants run in the owned worker;
   * AMI-zlib streams are zlib-wrapped and decode synchronously on the main
   * thread through node:zlib, still respecting the shared output budget.
   */
  async #decodeStream(
    payload: Buffer,
    format: "lzma" | "zlib",
    signal?: AbortSignal,
  ): Promise<UefiLzmaWorkerDecode> {
    signal?.throwIfAborted();
    if (format === "zlib") {
      try {
        const bytes = inflateSync(payload, {
          maxOutputLength: UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
        });
        return {
          ok: true,
          outcome: {
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            decoderVersion: process.versions.zlib ?? "unknown",
          },
        };
      } catch (cause: unknown) {
        return {
          ok: false,
          message:
            cause instanceof RangeError &&
            cause.message.includes("output length")
              ? `output-limit: zlib stream exceeds ${UEFI_FIRMWARE_LIMITS.lzmaOutputBytes} bytes`
              : `zlib decode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    }
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-uefi-lzma-" });
    try {
      const payloadPath = join(root.path, "payload.bin");
      const outputPath = join(root.path, "output.bin");
      const replyPath = join(root.path, "reply.json");
      const requestPath = join(root.path, "request.json");
      await writeFile(payloadPath, payload, { flag: "wx", mode: 0o600 });
      await writeFile(
        requestPath,
        JSON.stringify({
          payload_path: payloadPath,
          output_path: outputPath,
          reply_path: replyPath,
          max_output_bytes: UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const { NODE_OPTIONS: _ambientNodeOptions, ...environment } = process.env;
      await runOwnedCommand(
        {
          command: process.execPath,
          arguments: [
            "--max-old-space-size=256",
            "--disable-wasm-trap-handler",
            this.#workerModulePath,
            requestPath,
          ],
          cwd: root.path,
          expectedCommand: null,
          runId: `rea-uefi-lzma-${randomUUID()}`,
          hostEnvironment: environment,
        },
        {
          timeoutMs: UEFI_FIRMWARE_LIMITS.timeoutMs,
          diagnosticBytes: UEFI_FIRMWARE_LIMITS.diagnosticBytes,
        },
        signal === undefined ? {} : { signal },
      );
      const replyFile = await readStableArtifact(
        replyPath,
        UEFI_FIRMWARE_LIMITS.diagnosticBytes,
        signal,
        undefined,
        this.#resources,
      );
      const reply = lzmaReplySchema.parse(
        JSON.parse(replyFile.bytes.toString("utf8")),
      );
      if (!reply.ok) {
        return { ok: false, message: `${reply.reason}: ${reply.message}` };
      }
      if (signal?.aborted) {
        throw new AnalysisCancelledError("extract_uefi_firmware", {
          cause: signal.reason,
        });
      }
      const decoded = await readStableArtifact(
        outputPath,
        UEFI_FIRMWARE_LIMITS.lzmaOutputBytes,
        signal,
        undefined,
        this.#resources,
      );
      if (decoded.sha256 !== reply.output.sha256) {
        return {
          ok: false,
          message: `LZMA worker output digest mismatch (${reply.output.sha256}).`,
        };
      }
      return {
        ok: true,
        outcome: {
          bytes: decoded.bytes,
          sha256: decoded.sha256,
          decoderVersion: reply.lzma_version,
        },
      };
    } finally {
      await root.close();
    }
  }
}
