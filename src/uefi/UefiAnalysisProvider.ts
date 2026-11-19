import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
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
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { digestSchema } from "../domain/digests.js";
import type { Result } from "../domain/result.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import {
  uefiResultSchemas,
  type UefiExtractResult,
  type UefiInspectResult,
  type UefiNvramInspectResult,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import type { UefiRequest } from "../domain/uefi/uefiFirmwareAnalysis.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type {
  UefiImageScanSummary,
  UefiDecodeResult,
  UefiPayload,
} from "./UefiImageScan.js";
import { scanUefiImage } from "./UefiImageScan.js";
import { scanAmiNvramStores } from "./UefiNvram.js";
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

const inflateBounded = promisify(inflate);
const FFS_FILE_TYPE_PAD = 0xf0;

const hex = (value: number): string => `0x${value.toString(16)}`;

const targetInputError = (message: string): AnalysisInputError =>
  new AnalysisInputError("extract_uefi_firmware", { cause: undefined }, [
    { path: ["target"], reason: "invalid_value", message },
  ]);

type ExtractInput = Extract<
  UefiRequest,
  { operation: "extract_uefi_firmware" }
>["input"];
type ExtractedFile = UefiExtractResult["files"][number];
type ExtractionRange = UefiPayload["range"];

/** Offsets are scoped to the scanner's exact stream and may repeat across streams. */
const selectTarget = (
  scan: UefiImageScanSummary,
  target: ExtractInput["target"],
) => {
  if (target.kind === "whole-image") {
    return {
      offset: 0,
      length: scan.inputSize,
      logical_path: "flash",
      source_stream: null,
    };
  }
  const matches = (record: {
    offset: number;
    source_stream: string | null;
  }): boolean =>
    record.offset === target.offset &&
    (target.source_stream === undefined ||
      record.source_stream === target.source_stream);
  const records =
    target.kind === "volume"
      ? scan.volumes
      : target.kind === "ffs-file"
        ? scan.volumes.flatMap((volume) => volume.ffs_files)
        : scan.volumes.flatMap((volume) =>
            volume.ffs_files.flatMap((file) => file.sections),
          );
  const selected = records.filter(matches);
  const record = selected[0];
  if (record === undefined) {
    throw targetInputError(
      `No mapped ${target.kind} at ${hex(target.offset)} in the selected stream.`,
    );
  }
  if (selected.length > 1) {
    throw targetInputError(
      `The ${target.kind} offset ${hex(target.offset)} appears in multiple streams. Select one with source_stream: ${selected.map(({ source_stream }) => JSON.stringify(source_stream)).join(", ")}.`,
    );
  }
  return record;
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
    const signal = options?.signal;
    if (signal?.aborted) return this.#cancelled(request, signal.reason);
    const started = { value: false };
    const queued = this.#serialize(async () => {
      started.value = true;
      // A queued request cancelled while waiting must not run behind the active
      // one; skip it when it reaches the head of the queue.
      if (signal?.aborted) return this.#cancelled(request, signal.reason);
      return this.#executeWithDeadline(request, options);
    });
    // Let a caller stop waiting on a not-yet-started request immediately.
    return signal === undefined
      ? queued
      : this.#raceWithAbort(queued, request, signal, started);
  }

  #cancelled(
    request: UefiRequest,
    reason: unknown,
  ): Result<AnalysisExecution, AnalysisError> {
    return {
      ok: false,
      error: new AnalysisCancelledError(request.operation, { cause: reason }),
    };
  }

  #raceWithAbort(
    queued: Promise<Result<AnalysisExecution, AnalysisError>>,
    request: UefiRequest,
    signal: AbortSignal,
    started: { value: boolean },
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (signal.aborted && !started.value) {
      return Promise.resolve(this.#cancelled(request, signal.reason));
    }
    return new Promise<Result<AnalysisExecution, AnalysisError>>((resolve) => {
      const onAbort = () => {
        // Only a not-yet-started job may return early; a started job must finish
        // so its cleanup and completed work are preserved.
        if (!started.value) resolve(this.#cancelled(request, signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queued.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", onAbort);
          resolve({
            ok: false,
            error: uefiFailure(cause, request.operation, request.input.path),
          });
        },
      );
    });
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
    const timeoutMs = UEFI_FIRMWARE_LIMITS.timeoutMs;
    const deadline = performance.now() + timeoutMs;
    const deadlineReason = new AnalysisTimeoutError(
      request.operation,
      timeoutMs,
    );
    const expire = () => controller.abort(deadlineReason);
    const timer = setTimeout(expire, timeoutMs);
    const parent = options?.signal;
    const onParentAbort = () =>
      controller.abort(
        new AnalysisCancelledError(request.operation, {
          cause: parent?.reason,
        }),
      );
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });
    const checkpoint = (): void => {
      if (performance.now() >= deadline) expire();
      controller.signal.throwIfAborted();
    };
    try {
      return {
        ok: true,
        value: await this.#executeWithSignal(
          request,
          controller.signal,
          checkpoint,
        ),
      };
    } catch (cause: unknown) {
      return {
        ok: false,
        error: uefiFailure(cause, request.operation, request.input.path),
      };
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    }
  }

  async #executeWithSignal(
    request: UefiRequest,
    signal: AbortSignal,
    checkpoint: () => void,
  ): Promise<AnalysisExecution> {
    const finishObservation = (value: AnalysisExecution): AnalysisExecution => {
      try {
        checkpoint();
        return value;
      } catch (cause: unknown) {
        throw uefiFailure(
          cause,
          request.operation,
          request.input.path,
        ).retainPartialObservation({
          kind: "uefi",
          result: value.result,
          provenance: jsonValueSchema.parse(value.subject),
        });
      }
    };
    return this.#resources.run(async () => {
      checkpoint();
      const snapshot = await readStableArtifact(
        request.input.path,
        UEFI_FIRMWARE_LIMITS.inputBytes,
        signal,
        undefined,
        this.#resources,
      );
      checkpoint();
      if (request.operation === "inspect_uefi_nvram") {
        const value = this.#inspectNvram(
          request,
          snapshot.sha256,
          snapshot.bytes,
          checkpoint,
        );
        return finishObservation(value);
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
        ({ payload, format, maxOutputBytes }) =>
          this.#decodeStream(
            request.operation,
            payload,
            format,
            maxOutputBytes,
            signal,
          ),
        checkpoint,
      );
      checkpoint();
      if (request.operation === "extract_uefi_firmware") {
        return this.#extract(
          request,
          snapshot.sha256,
          scan,
          signal,
          checkpoint,
        );
      }
      return finishObservation(this.#inspect(request, snapshot.sha256, scan));
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
          : scan.pspTables.some((table) => table.offset < firstVolume.offset)
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
            declared_location_raw: entry.declaredLocationRaw,
            address_mode: entry.addressMode,
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
    checkpoint: () => void,
  ): AnalysisExecution {
    const scan = scanAmiNvramStores(
      image,
      request.input.max_stores,
      request.input.max_depth,
      checkpoint,
    );
    const result: UefiNvramInspectResult =
      uefiResultSchemas.inspect_uefi_nvram.parse({
        parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
        input_size: image.length,
        image_sha256: imageSha256,
        stores: scan.stores.map((store) => ({
          offset: store.offset,
          name: store.name,
          variables: store.variables.map((variable) => {
            checkpoint();
            return {
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
            };
          }),
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
    imageSha256: string,
    scan: UefiImageScanSummary,
    signal: AbortSignal,
    checkpoint: () => void,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const selection = selectTarget(scan, input.target);
    const includes = (path: string) =>
      path === selection.logical_path ||
      path.startsWith(`${selection.logical_path}/`);
    const gaps: UefiExtractResult["extraction_gaps"] = [];
    const derivations: UefiExtractResult["derivations"] = [];
    const plan: {
      readonly entry: UefiPublicationEntry;
      readonly facts: Omit<
        ExtractedFile,
        "path" | "size" | "sha256" | "relative_path"
      >;
    }[] = [];
    const emittedStreams = new Set<string>();
    let stagedBytes = 0;

    const gap = (
      kind: UefiExtractResult["extraction_gaps"][number]["kind"],
      logical_path: string,
      source_stream: string | null,
      range: ExtractionRange | null,
      detail: string,
    ): void => {
      gaps.push({ kind, logical_path, source_stream, range, detail });
    };

    const stage = (
      logicalPath: string,
      suffix: string,
      payload: UefiPayload,
      source: ExtractedFile["source"],
      parentLogicalPath: string | null,
      mediaType: string | null = null,
    ): string | null => {
      checkpoint();
      if (payload.bytes.length === 0) return null;
      if (
        plan.length >= input.max_output_files ||
        stagedBytes + payload.bytes.length > input.max_output_bytes
      ) {
        gap(
          "size-truncated",
          logicalPath,
          payload.sourceStream,
          payload.range,
          `Output file or byte limit prevented publication of ${logicalPath}.`,
        );
        return null;
      }
      // Logical labels retain ':' and brackets. Output paths use portable
      // characters and distinguish repeated GUIDs by their observed file offset.
      const relativePath = `${logicalPath.replaceAll(":", "-").replaceAll("[", "-").replaceAll("]", "")}.${suffix}.bin`;
      stagedBytes += payload.bytes.length;
      plan.push({
        entry: { relativePath, bytes: payload.bytes },
        facts: {
          original_file_range:
            payload.sourceStream === null ? payload.range : null,
          source_stream: payload.sourceStream,
          source_range: payload.range,
          runtime_address: null,
          media_type: mediaType,
          source,
          parent_logical_path: parentLogicalPath,
        },
      });
      return relativePath;
    };

    const recordDerivation = (stream: string | null): void => {
      if (stream === null || emittedStreams.has(stream)) return;
      const decoded = scan.decodedStreams.get(stream);
      if (decoded === undefined)
        throw new Error(`Missing decoded source ${stream}.`);
      const { carrier, format, decoderVersion } = decoded;
      recordDerivation(carrier.sourceStream);
      emittedStreams.add(stream);
      const child = includes(stream)
        ? stage(
            stream,
            "decoded",
            {
              bytes: decoded.bytes,
              sourceStream: stream,
              range: { offset: 0, length: decoded.bytes.length },
            },
            format === "zlib" ? "decompressed-zlib" : "decompressed-lzma",
            stream,
          )
        : null;
      derivations.push({
        parent_path: stream,
        parent_file_range: carrier.sourceStream === null ? carrier.range : null,
        parent_stream: carrier.sourceStream,
        parent_stream_range: carrier.range,
        child_path: child,
        child_stream: stream,
        handler: `${format === "zlib" ? "node-zlib" : "lzma-purejs"}@${decoderVersion}`,
      });
    };

    for (const volume of scan.volumes) {
      for (const file of volume.ffs_files) {
        checkpoint();
        if (includes(file.logical_path)) {
          const range = { offset: file.offset, length: file.length };
          if (file.type_code === FFS_FILE_TYPE_PAD) {
            gap(
              "pad-file",
              file.logical_path,
              file.source_stream,
              range,
              "Pad file extent retained.",
            );
            continue;
          }
          if (
            file.declared_length < file.header_length ||
            file.declared_length > file.length
          ) {
            gap(
              "size-truncated",
              file.logical_path,
              file.source_stream,
              range,
              `FFS declares ${file.declared_length} bytes; observed ${file.length} bytes with a ${file.header_length}-byte header.`,
            );
          } else {
            const raw = scan.payloads.get(file.logical_path);
            if (raw !== undefined) {
              recordDerivation(raw.sourceStream);
              stage(
                file.logical_path,
                "body",
                raw,
                "uncompressed-payload",
                null,
              );
            }
          }
        }
        for (const section of file.sections) {
          if (!includes(section.logical_path)) continue;
          checkpoint();
          const path = section.logical_path;
          const payload = scan.payloads.get(path);
          if (section.truncated || section.malformed) {
            gap(
              section.truncated ? "size-truncated" : "unparsed-region",
              path,
              section.source_stream,
              { offset: section.offset, length: section.length },
              `Section framing is ${section.malformed ? "malformed" : "truncated"}; declared ${section.declared_length} bytes, observed ${section.length}.`,
            );
          } else if (scan.decodedStreams.has(path)) {
            recordDerivation(path);
          } else if (section.compression.kind !== "none") {
            gap(
              section.compression.kind === "unknown-guid"
                ? "unknown-guid-handler"
                : "unsupported-compression",
              path,
              section.source_stream,
              payload?.range ?? null,
              scan.decodeGaps.get(path) ??
                `No decoded payload for ${section.compression.kind}.`,
            );
            if (input.include_compressed && payload !== undefined) {
              recordDerivation(payload.sourceStream);
              stage(
                path,
                "compressed",
                payload,
                "compressed-passthrough",
                section.parent_logical_path,
              );
            }
          } else if (
            payload !== undefined &&
            section.sub_volumes.length === 0
          ) {
            recordDerivation(payload.sourceStream);
            stage(
              path,
              "payload",
              payload,
              "raw-section",
              section.parent_logical_path,
              section.type_code === 0x10
                ? "application/vnd.microsoft.portable-executable"
                : null,
            );
          }
        }
      }
    }

    const publication = await publishUefiFiles({
      outputDirectory: input.output_directory,
      operation: request.operation,
      entries: plan.map(({ entry }) => entry),
      resources: this.#resources,
      signal,
      checkpoint,
    });
    const result: UefiExtractResult =
      uefiResultSchemas.extract_uefi_firmware.parse({
        parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
        selection: {
          offset: selection.offset,
          length: selection.length,
          source_stream: selection.source_stream,
          target_kind: input.target.kind,
        },
        output_directory: publication.outputRoot,
        coverage:
          gaps.some(({ kind }) => kind !== "pad-file") ||
          scan.budgetExhausted ||
          scan.truncationObserved
            ? "partial"
            : "complete",
        files: publication.files.map((file, index) => ({
          ...file,
          ...plan[index]?.facts,
        })),
        derivations,
        extraction_gaps: gaps,
        diagnostics: `${scan.volumes.length} volumes mapped; ${derivations.length} stream derivation(s), ${gaps.length} gap(s); published ${plan.length} file(s), ${stagedBytes} bytes.`,
        published_bytes: stagedBytes,
      });
    if (publication.failure !== undefined) {
      throw publication.failure.retainPartialObservation({
        kind: "uefi",
        result: jsonValueSchema.parse(result),
        provenance: { path: input.path, sha256: imageSha256 },
      });
    }
    return createAnalysisExecution(result, UEFI_PROVIDER_IDENTITY, {
      subject: { path: input.path, sha256: imageSha256, format: "file" },
      locations: [{ kind: "artifact-path", path: input.path }],
      limitations: scan.limitations,
    });
  }

  async #decodeStream(
    operation: UefiRequest["operation"],
    payload: Buffer,
    format: "lzma" | "zlib",
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<UefiDecodeResult> {
    signal.throwIfAborted();
    if (format === "zlib") {
      try {
        const bytes = await inflateBounded(payload, {
          maxOutputLength: maxOutputBytes,
        });
        return {
          ok: true,
          outcome: {
            bytes,
            decoderVersion: process.versions.zlib ?? "unknown",
          },
        };
      } catch (cause: unknown) {
        return {
          ok: false,
          message:
            cause instanceof RangeError &&
            "code" in cause &&
            cause.code === "ERR_BUFFER_TOO_LARGE"
              ? `output-limit: zlib stream exceeds ${maxOutputBytes} bytes`
              : `zlib decode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    }
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-uefi-lzma-" });
    const decode = async (): Promise<UefiDecodeResult> => {
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
          max_output_bytes: maxOutputBytes,
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
        { signal },
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
      signal.throwIfAborted();
      const decoded = await readStableArtifact(
        outputPath,
        maxOutputBytes,
        signal,
        undefined,
        this.#resources,
      );
      if (
        decoded.sha256 !== reply.output.sha256 ||
        decoded.bytes.length !== reply.output.bytes
      ) {
        return {
          ok: false,
          message: `LZMA worker output digest mismatch (${reply.output.sha256}).`,
        };
      }
      return {
        ok: true,
        outcome: {
          bytes: decoded.bytes,
          decoderVersion: reply.lzma_version,
        },
      };
    };

    let outcome: UefiDecodeResult | undefined;
    let primary: AnalysisError | undefined;
    try {
      outcome = await decode();
    } catch (cause: unknown) {
      primary = uefiFailure(cause, operation, root.path);
      const preparation =
        cause instanceof OwnedCommandFailure
          ? cause.preparationFailure
          : cause instanceof DarwinProcessOwnershipInspectionError
            ? cause
            : undefined;
      if (preparation?.cleanupFailure?.cleanupIncomplete === true) {
        const failure = preparation.cleanupFailure;
        const lease = new AnalysisCleanupLease(async () => {
          if (!failure.cleanupIncomplete) return;
          if (preparation.cleanupOwner === undefined) throw failure;
          await preparation.cleanupOwner.close();
          if (failure.cleanupIncomplete) throw failure;
        }, failure.cleanupResources);
        this.#resources.retain({
          kind: "lease",
          resource: failure.cleanupResources[0] ?? "worker launch preparation",
          lease,
        });
        new AnalysisCleanupLeaseGroup(failure, [lease]);
        primary = analysisErrorWithCleanupFailure(
          primary,
          failure,
          operation,
        ).bindCleanupDependencies([primary, failure]);
      }
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      ) {
        const owner = cause.cleanupOwner;
        const lease = new AnalysisCleanupLease(async () => {
          const stopped = await owner.stop();
          if (stopped.status === "incomplete") throw new Error(stopped.reason);
          await root.close();
        }, cause.resources);
        this.#resources.retain({ kind: "lease", resource: root.path, lease });
        new AnalysisCleanupLeaseGroup(primary, [lease]);
        throw primary;
      }
    }
    const released = await this.#resources.release({
      kind: "private-runtime-root",
      resource: root.path,
      root,
    });
    if (released.kind === "failed") {
      const cleanup = new ProviderCleanupError(
        UEFI_PROVIDER_IDENTITY.id,
        [root.path],
        { reason: String(released.cause) },
        { cause: released.cause, operation },
      );
      const failure =
        primary === undefined
          ? cleanup
          : analysisErrorWithCleanupFailure(primary, cleanup, operation);
      new AnalysisCleanupLeaseGroup(cleanup, [released.lease]);
      if (primary !== undefined)
        failure.bindCleanupDependencies([primary, cleanup]);
      throw failure;
    }
    if (primary !== undefined) throw primary;
    signal.throwIfAborted();
    if (outcome === undefined) throw new Error("UEFI decoder did not settle.");
    return outcome;
  }
}
