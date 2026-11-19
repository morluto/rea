import type { UefiDecodeFormat } from "./FfsSections.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { hostRangeErrorKind } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactResourceScope,
  readStableArtifact,
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../resources/index.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
  type ProviderAvailability,
} from "../ports/AnalysisProvider.js";
import type { UefiAnalysisPort } from "../ports/uefi/UefiAnalysisPort.js";
import {
  cancelledBy,
  carriedReason,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import {
  uefiResultSchemas,
  type UefiExtractResult,
  type UefiInspectResult,
  type UefiNvramInspectResult,
  type UefiRequest,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  processInspectionFailure,
  retainProcessInspectionCleanup,
} from "../providers/OwnedCommandCleanup.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type {
  UefiImageScanSummary,
  UefiDecodeResult,
  UefiPayload,
} from "./UefiImageScan.js";
import { scanUefiImage } from "./UefiImageScan.js";
import { scanAmiNvramStores } from "./UefiNvram.js";
import { uefiFailureDialect } from "./UefiFailures.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  publishUefiFiles,
  type UefiPublicationEntry,
} from "./UefiPublication.js";

import { lzmaReplySchema } from "./UefiLzmaProtocol.js";
import { UEFI_PROVIDER_IDENTITY } from "./UefiProviderIdentity.js";

const inflateBounded = promisify(inflate);

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
      error: cancelledBy(request.operation, carriedReason(reason)),
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
            error: classifyProviderFailure(
              cause,
              uefiFailureDialect(request.operation, request.input.path),
            ),
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
        cancelledBy(request.operation, carriedReason(parent?.reason)),
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
        error: classifyProviderFailure(
          cause,
          uefiFailureDialect(request.operation, request.input.path),
        ),
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
        throw classifyProviderFailure(
          cause,
          uefiFailureDialect(request.operation, request.input.path),
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
              next: variable.next,
              guid_index: variable.guidIndex,
              guid: variable.guid,
              depth: variable.depth,
              parent_offset: variable.parentOffset,
              data_offset: variable.dataOffset,
              data_length: variable.dataLength,
              data_sha256: sha256Hex(
                image.subarray(
                  variable.dataOffset,
                  variable.dataOffset + variable.dataLength,
                ),
              ),
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
    const plan: UefiPublicationEntry[] = [];
    const emittedStreams = new Set<string>();
    let stagedBytes = 0;

    const gap = (
      kind: UefiExtractResult["extraction_gaps"][number]["kind"],
      logical_path: string,
      source_stream: string | null,
      range: ExtractionRange | null,
      detail: string,
    ): void => {
      gaps.push({
        kind,
        logical_path,
        source_stream,
        range: range !== null && range.length > 0 ? range : null,
        detail,
      });
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
        relativePath,
        bytes: payload.bytes,
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
            `decompressed-${format}`,
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
        handler: `${format === "zlib" ? "node-zlib" : "lzma-purejs"}@${decoderVersion}${format === "lzmaf86" ? "+x86-bcj" : ""}`,
      });
    };

    for (const volume of scan.volumes) {
      for (const file of volume.ffs_files) {
        checkpoint();
        if (includes(file.logical_path)) {
          recordDerivation(file.source_stream);
          const raw = scan.payloads.get(file.logical_path);
          if (raw !== undefined) {
            stage(file.logical_path, "body", raw, "uncompressed-payload", null);
          }
        }
        for (const section of file.sections) {
          if (!includes(section.logical_path)) continue;
          checkpoint();
          if (section.truncated || section.malformed) continue;
          const path = section.logical_path;
          recordDerivation(section.source_stream);
          const payload = scan.payloads.get(path);
          const carrier = scan.compressedCarriers.get(path);
          if (scan.decodedStreams.has(path)) {
            recordDerivation(path);
          } else if (carrier !== undefined && input.include_compressed) {
            stage(
              path,
              "compressed",
              carrier,
              "compressed-passthrough",
              section.parent_logical_path,
            );
          } else if (
            payload !== undefined &&
            section.sub_volumes.length === 0
          ) {
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

    for (const omission of scan.omissions) {
      if (!includes(omission.logical_path)) continue;
      checkpoint();
      recordDerivation(omission.source_stream);
      gaps.push(omission);
    }
    if (scan.volumes.length === 0 && gaps.length === 0) {
      gap(
        "unparsed-region",
        selection.logical_path,
        selection.source_stream,
        { offset: selection.offset, length: selection.length },
        "No firmware volumes were mapped in the input image.",
      );
    }

    const publication = await publishUefiFiles({
      outputDirectory: input.output_directory,
      operation: request.operation,
      entries: plan,
      resources: this.#resources,
      signal,
      checkpoint,
      buildResult: (outputRoot, files) =>
        uefiResultSchemas.extract_uefi_firmware.parse({
          parser: { name: "rea-uefi", version: UEFI_PROVIDER_IDENTITY.version },
          selection: {
            offset: selection.offset,
            length: selection.length,
            source_stream: selection.source_stream,
            target_kind: input.target.kind,
          },
          output_directory: outputRoot,
          coverage: gaps.some(({ kind }) => kind !== "pad-file")
            ? "partial"
            : "complete",
          files,
          derivations,
          extraction_gaps: gaps,
          diagnostics: `${scan.volumes.length} volumes mapped; ${derivations.length} stream derivation(s), ${gaps.length} gap(s); wrote ${files.length} file(s).`,
          published_bytes: files.reduce((total, file) => total + file.size, 0),
        }),
    });
    const { result } = publication;
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
      limitations:
        input.target.kind === "whole-image"
          ? scan.limitations
          : gaps
              .filter(({ kind }) => kind !== "pad-file")
              .slice(0, 512)
              .map(({ detail }) => detail),
    });
  }

  async #decodeStream(
    operation: UefiRequest["operation"],
    payload: Buffer,
    format: UefiDecodeFormat,
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<UefiDecodeResult> {
    signal.throwIfAborted();
    if (format === "zlib") {
      try {
        const decoded: unknown = await inflateBounded(payload, {
          info: true,
          maxOutputLength: maxOutputBytes,
        });
        // Node's callback declarations omit the documented info:true result.
        const { buffer: bytes, engine } = decoded as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (engine.bytesWritten !== payload.length)
          return {
            ok: false,
            reason: "format",
            message: `AMD zlib stream used ${engine.bytesWritten} of ${payload.length} declared compressed bytes.`,
          };
        return {
          ok: true,
          outcome: {
            bytes,
            decoderVersion: process.versions.zlib ?? "unknown",
          },
        };
      } catch (cause: unknown) {
        const limit = hostRangeErrorKind(cause) === "host-capacity";
        return {
          ok: false,
          reason: limit ? "output-limit" : "decoder",
          message: limit
            ? `zlib output exceeds the configured or host buffer ceiling of ${maxOutputBytes} bytes: ${errorMessage(cause)}`
            : errorMessage(cause),
        };
      }
    }
    const root = await PrivateRuntimeRoot.create({ prefix: "rea-uefi-lzma-" });
    const files = new ArtifactResourceScope();
    let worker: OwnedCommandFailure | undefined;
    const rootLease = AnalysisCleanupLease.forCloseOwner(
      {
        async close() {
          if (worker?.cleanupOwner !== undefined) {
            const stopped = await worker.cleanupOwner.stop();
            if (stopped.status === "incomplete")
              throw new Error(stopped.reason);
            worker = undefined;
          }
          await files.close();
          await root.close();
        },
        get cleanupResources() {
          return [
            ...new Set([
              ...(worker?.resources ?? []),
              ...files.cleanupResources,
              root.path,
            ]),
          ];
        },
      },
      root.path,
    );
    const workspace = {
      kind: "lease",
      resource: root.path,
      lease: rootLease,
    } as const;
    const decode = async (): Promise<UefiDecodeResult> => {
      const payloadPath = join(root.path, "payload.bin");
      const outputPath = join(root.path, "output.bin");
      const replyPath = join(root.path, "reply.json");
      const requestPath = join(root.path, "request.json");
      await writeFile(payloadPath, payload, { flag: "wx", mode: 0o600 });
      await writeFile(
        requestPath,
        JSON.stringify({
          format,
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
        files,
      );
      const reply = lzmaReplySchema.parse(
        JSON.parse(replyFile.bytes.toString("utf8")),
      );
      if (!reply.ok) {
        return reply;
      }
      signal.throwIfAborted();
      const decoded = await readStableArtifact(
        outputPath,
        maxOutputBytes,
        signal,
        undefined,
        files,
      );
      if (
        decoded.sha256 !== reply.output.sha256 ||
        decoded.bytes.length !== reply.output.bytes
      ) {
        return {
          ok: false,
          reason: "decoder",
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
      primary = classifyProviderFailure(
        cause,
        uefiFailureDialect(operation, root.path),
      );
      const preparation = processInspectionFailure(cause);
      if (preparation !== undefined) {
        primary = retainProcessInspectionCleanup(
          preparation,
          primary,
          this.#resources,
          operation,
        );
      }
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      ) {
        worker = cause;
        this.#resources.retain(workspace);
        new AnalysisCleanupLeaseGroup(primary, [rootLease]);
        throw primary;
      }
    }
    const cleanup = (reason: string, cause?: unknown) => {
      const failure = new ProviderCleanupError(
        UEFI_PROVIDER_IDENTITY.id,
        rootLease.cleanupResources ?? [root.path],
        { reason },
        { cause, operation },
      );
      new AnalysisCleanupLeaseGroup(failure, [rootLease]);
      return primary === undefined
        ? failure
        : analysisErrorWithCleanupDependencies(primary, failure, operation);
    };
    if (files.hasPending) {
      this.#resources.retain(workspace);
      throw cleanup(
        "Worker output descriptors must close before the temporary root can be removed.",
      );
    }
    const released = await this.#resources.release(workspace);
    if (released.kind === "failed")
      throw cleanup(errorMessage(released.cause), released.cause);
    if (primary !== undefined) throw primary;
    signal.throwIfAborted();
    if (outcome === undefined) throw new Error("UEFI decoder did not settle.");
    return outcome;
  }
}
