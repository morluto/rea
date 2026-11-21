import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import type { UefiDecodeFormat } from "./FfsSections.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { hostRangeErrorKind } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { isAbortOf } from "../process/SignalAbort.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
} from "../process/WindowsBatchCommand.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
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
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
  AnalysisInputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ellipsisExcerpt } from "../domain/excerpt.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../domain/unicodeCodePointOrder.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import {
  uefiResultSchemas,
  type UefiDecompileResult,
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
  type UefiWriteReceipt,
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

interface DiscoveredUefiModule {
  readonly guid: string | null;
  readonly rawName: string;
  readonly cleanName: string;
  readonly phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC";
  readonly typeName?: string;
  readonly bytes?: Buffer;
  readonly sourcePath?: string;
  readonly byteLength: number;
}

interface UefiEntryPointScaffolding {
  readonly typedefs: readonly string[];
  readonly prototype: string;
  readonly functionDefinition: string;
}

export const buildUefiEntryPointScaffolding = (
  identifier: string,
  rawName: string,
  byteLength: number,
  phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC",
  typeName?: string,
): UefiEntryPointScaffolding => {
  const normType = typeName?.toLowerCase();
  if (normType === "pei-core") {
    return {
      typedefs: [
        "typedef void* EFI_SEC_PEI_HAND_OFF;",
        "typedef void* EFI_PEI_PPI_DESCRIPTOR;",
      ],
      prototype: `void EFIAPI ${identifier}EntryPoint(const EFI_SEC_PEI_HAND_OFF *SecCoreData, const EFI_PEI_PPI_DESCRIPTOR *PpiList, void *Context);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        "    const EFI_SEC_PEI_HAND_OFF *SecCoreData,",
        "    const EFI_PEI_PPI_DESCRIPTOR *PpiList,",
        "    void *Context",
        ") {",
        `    // Reconstructed PEI Core EntryPoint scaffolding for ${rawName}`,
        `    // Size: ${byteLength} bytes`,
        "    (void)SecCoreData;",
        "    (void)PpiList;",
        "    (void)Context;",
        "}",
      ].join("\n"),
    };
  }

  if (normType === "peim" || (normType === undefined && phase === "PEI")) {
    return {
      typedefs: [
        "typedef int64_t EFI_STATUS;",
        "typedef void* EFI_PEI_FILE_HANDLE;",
        "struct _EFI_PEI_SERVICES;",
        "typedef struct _EFI_PEI_SERVICES EFI_PEI_SERVICES;",
        "#define EFI_SUCCESS 0",
      ],
      prototype: `EFI_STATUS EFIAPI ${identifier}EntryPoint(EFI_PEI_FILE_HANDLE FileHandle, const EFI_PEI_SERVICES **PeiServices);`,
      functionDefinition: [
        `EFI_STATUS EFIAPI ${identifier}EntryPoint(`,
        "    EFI_PEI_FILE_HANDLE FileHandle,",
        "    const EFI_PEI_SERVICES **PeiServices",
        ") {",
        `    // Reconstructed PEIM EntryPoint scaffolding for ${rawName}`,
        `    // Size: ${byteLength} bytes`,
        "    EFI_STATUS Status = EFI_SUCCESS;",
        "    (void)FileHandle;",
        "    (void)PeiServices;",
        "    return Status;",
        "}",
      ].join("\n"),
    };
  }

  if (
    normType === "security-core" ||
    (normType === undefined && phase === "SEC")
  ) {
    return {
      typedefs: [],
      prototype: `void EFIAPI ${identifier}EntryPoint(void *PeiCoreEntryPoint);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        "    void *PeiCoreEntryPoint",
        ") {",
        `    // Reconstructed SEC EntryPoint scaffolding for ${rawName}`,
        `    // Size: ${byteLength} bytes`,
        "    (void)PeiCoreEntryPoint;",
        "}",
      ].join("\n"),
    };
  }

  if (normType === "dxe-core") {
    return {
      typedefs: [],
      prototype: `void EFIAPI ${identifier}EntryPoint(void *HobStart);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        "    void *HobStart",
        ") {",
        `    // Reconstructed DXE Core EntryPoint scaffolding for ${rawName}`,
        `    // Size: ${byteLength} bytes`,
        "    (void)HobStart;",
        "}",
      ].join("\n"),
    };
  }

  return {
    typedefs: [
      "typedef int64_t EFI_STATUS;",
      "typedef void* EFI_HANDLE;",
      "struct _EFI_SYSTEM_TABLE;",
      "typedef struct _EFI_SYSTEM_TABLE EFI_SYSTEM_TABLE;",
      "#define EFI_SUCCESS 0",
    ],
    prototype: `EFI_STATUS EFIAPI ${identifier}EntryPoint(EFI_HANDLE ImageHandle, EFI_SYSTEM_TABLE *SystemTable);`,
    functionDefinition: [
      `EFI_STATUS EFIAPI ${identifier}EntryPoint(`,
      "    EFI_HANDLE ImageHandle,",
      "    EFI_SYSTEM_TABLE *SystemTable",
      ") {",
      `    // Reconstructed EntryPoint scaffolding for ${rawName}`,
      `    // Size: ${byteLength} bytes`,
      "    EFI_STATUS Status = EFI_SUCCESS;",
      "    (void)ImageHandle;",
      "    (void)SystemTable;",
      "    return Status;",
      "}",
    ].join("\n"),
  };
};

const resolveGhidraHeadless = (): string | null => {
  const isWindows = HOST_PLATFORM.platform === "win32";
  const headlessName = isWindows ? "analyzeHeadless.bat" : "analyzeHeadless";
  const ghidraRunName = isWindows ? "ghidraRun.bat" : "ghidraRun";

  const envDir = process.env.GHIDRA_INSTALL_DIR;
  if (typeof envDir === "string" && envDir.length > 0) {
    const candidate = join(envDir, "support", headlessName);
    if (existsSync(candidate)) return candidate;
  }

  const pathEnv = process.env.PATH ?? "";
  const pathDirs = pathEnv
    .split(isWindows ? ";" : ":")
    .filter((p) => p.length > 0);
  for (const dir of pathDirs) {
    const directHeadless = join(dir, headlessName);
    if (existsSync(directHeadless)) return directHeadless;

    const subHeadless = join(dir, "support", headlessName);
    if (existsSync(subHeadless)) return subHeadless;

    const ghidraRun = join(dir, ghidraRunName);
    if (existsSync(ghidraRun)) {
      const fromGhidraRun = join(dir, "support", headlessName);
      if (existsSync(fromGhidraRun)) return fromGhidraRun;
    }
  }

  const systemCandidates = ["/opt/ghidra", "/usr/share/ghidra"];
  for (const root of systemCandidates) {
    const candidate = join(root, "support", headlessName);
    if (existsSync(candidate)) return candidate;
  }

  return null;
};

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
      error:
        reason instanceof AnalysisTimeoutError
          ? new AnalysisTimeoutError(request.operation, reason.timeoutMs, {
              cause: reason,
            })
          : cancelledBy(request.operation, carriedReason(reason)),
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
    const onParentAbort = () => {
      const reason = parent?.reason;
      if (reason instanceof AnalysisTimeoutError) {
        controller.abort(reason);
      } else {
        controller.abort(cancelledBy(request.operation, carriedReason(reason)));
      }
    };
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
      let isDirectory = false;
      try {
        const pathStat = await stat(request.input.path);
        isDirectory = pathStat.isDirectory();
      } catch {
        // Continue to regular file artifact read
      }
      if (isDirectory && request.operation === "decompile_uefi_firmware") {
        return await this.#decompileDirectory(request, signal, checkpoint);
      }
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
        request.operation === "decompile_uefi_firmware"
          ? {
              maxDepth: UEFI_FIRMWARE_LIMITS.defaultMaxDepth,
              maxVolumes: UEFI_FIRMWARE_LIMITS.defaultMaxVolumes,
              maxFiles: UEFI_FIRMWARE_LIMITS.defaultMaxFiles,
            }
          : {
              maxDepth: request.input.max_depth,
              maxVolumes: request.input.max_volumes,
              maxFiles: request.input.max_files,
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
      if (request.operation === "decompile_uefi_firmware") {
        return this.#decompileFirmware(
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

    recordDerivation(selection.source_stream);
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

  async #stageAndPublishModules(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    imageSha256: string,
    discoveredModules: readonly DiscoveredUefiModule[],
    limitations: readonly string[],
    signal: AbortSignal,
    checkpoint: () => void,
    format: "file" | "directory" = "file",
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const modulesToProcess = discoveredModules.slice(0, input.max_modules);

    const effectiveLimitations = [...limitations];
    if (discoveredModules.length > input.max_modules) {
      effectiveLimitations.push(
        `Decompilation capped at ${input.max_modules} of ${discoveredModules.length} discovered modules.`,
      );
    }

    const tempRoot = await PrivateRuntimeRoot.create({
      prefix: "rea-uefi-decompile-",
    });

    const ghidraBin = resolveGhidraHeadless();

    const MAX_DISASSEMBLY_MODULE_BYTES = 2 * 1024 * 1024;
    const MAX_DISASSEMBLY_TOTAL_BYTES = 64 * 1024 * 1024;
    const MAX_DISASSEMBLY_FAILURE_DIAGNOSTICS = 20;
    let recordedDisassemblyFailures = 0;
    let totalStagedAsmBytes = 0;
    let disassemblyEngineUsed: "llvm-objdump" | "objdump" | "none" = "none";

    const MAX_DECOMPILE_MODULE_BYTES = 4 * 1024 * 1024;
    const MAX_DECOMPILE_TOTAL_BYTES = 64 * 1024 * 1024;
    let totalStagedCBytes = 0;

    const MAX_RAW_PAYLOAD_TOTAL_BYTES = 128 * 1024 * 1024;
    let totalStagedRawBytes = 0;

    let publishedResult: UefiDecompileResult | undefined;
    let establishedError: unknown;

    try {
      const occurrences = new Map<string, number>();
      const phaseCounts = {
        sec: 0,
        pei: 0,
        dxe: 0,
        smm: 0,
        app: 0,
        misc: 0,
      };

      const stagedModules: Array<{
        occurrence: number;
        guid: string | null;
        name: string;
        phase: string;
        disassembly_status: "ok" | "failed" | "omitted";
        relative_c_file: string;
        relative_asm_file: string | null;
        relative_header_file: string;
        relative_payload_file: string | null;
        c_sha256: string;
        asm_sha256: string | null;
        header_sha256: string;
        payload_sha256: string | null;
        c_generator: "ghidra" | "scaffold";
        asm_generator: "llvm-objdump" | "objdump" | null;
        code_bytes: number;
      }> = [];
      const publicationEntries: UefiPublicationEntry[] = [];

      for (const mod of modulesToProcess) {
        checkpoint();
        signal.throwIfAborted();

        const modBytes =
          mod.bytes ??
          (mod.sourcePath ? await readFile(mod.sourcePath) : Buffer.alloc(0));

        const phaseKey = mod.phase.toLowerCase() as keyof typeof phaseCounts;
        if (phaseCounts[phaseKey] !== undefined) {
          phaseCounts[phaseKey]++;
        }

        let cIdentifier = mod.cleanName.replace(/[^a-zA-Z0-9_]/g, "_");
        if (/^[0-9]/.test(cIdentifier)) {
          cIdentifier = `_${cIdentifier}`;
        }

        const dedupeKey = `${mod.phase}/${mod.guid ?? "noguid"}_${mod.cleanName}`;
        const occurrence = occurrences.get(dedupeKey) ?? 0;
        occurrences.set(dedupeKey, occurrence + 1);

        const subDir =
          occurrence === 0
            ? `${mod.guid ?? "noguid"}_${mod.cleanName}`
            : `${mod.guid ?? "noguid"}_${mod.cleanName}_${occurrence}`;
        const moduleRelDir = `${mod.phase}/${subDir}`;

        const efiRelPath = `${moduleRelDir}/${mod.cleanName}.efi`;
        let relativePayloadFile: string | null = null;
        let payloadSha256: string | null = null;
        if (
          totalStagedRawBytes + modBytes.length <=
          MAX_RAW_PAYLOAD_TOTAL_BYTES
        ) {
          publicationEntries.push({
            relativePath: efiRelPath,
            bytes: modBytes,
          });
          totalStagedRawBytes += modBytes.length;
          relativePayloadFile = efiRelPath;
          payloadSha256 = sha256Hex(modBytes);
        } else if (
          !effectiveLimitations.includes(
            "Raw executable payload staging truncated after reaching 128 MiB aggregate staging budget.",
          )
        ) {
          effectiveLimitations.push(
            "Raw executable payload staging truncated after reaching 128 MiB aggregate staging budget.",
          );
        }

        const scaffold = buildUefiEntryPointScaffolding(
          cIdentifier,
          mod.rawName,
          modBytes.length,
          mod.phase,
          mod.typeName,
        );

        const headerName = `${mod.cleanName}.h`;
        const headerRelPath = `${moduleRelDir}/${headerName}`;
        const headerGuard = `_UEFI_${cIdentifier.toUpperCase()}_H_`;
        const headerContent = [
          "/**",
          ` * UEFI Module Header: ${mod.rawName}`,
          ` * Phase: ${mod.phase}${mod.typeName ? ` | Type: ${mod.typeName}` : ""}`,
          ` * GUID: ${mod.guid ?? "N/A"}`,
          ` * Size: ${modBytes.length} bytes`,
          " */",
          `#ifndef ${headerGuard}`,
          `#define ${headerGuard}`,
          "",
          "#include <stdint.h>",
          "",
          "#ifndef EFIAPI",
          "#if defined(_WIN32) || defined(__CYGWIN__)",
          "#define EFIAPI __cdecl",
          "#else",
          "#define EFIAPI",
          "#endif",
          "#endif",
          "",
          ...scaffold.typedefs,
          ...(mod.guid
            ? [`#define ${cIdentifier.toUpperCase()}_GUID "${mod.guid}"`]
            : []),
          "",
          scaffold.prototype,
          "",
          `#endif // ${headerGuard}`,
          "",
        ].join("\n");
        const headerBytes = Buffer.from(headerContent, "utf8");
        const headerSha256 = sha256Hex(headerBytes);
        publicationEntries.push({
          relativePath: headerRelPath,
          bytes: headerBytes,
        });

        let asmRelPath: string | null = null;
        let asmSha256: string | null = null;
        let asmGenerator: "llvm-objdump" | "objdump" | null = null;
        let disassemblyStatus: "ok" | "failed" | "omitted" = "omitted";
        const tempEfiPath = join(
          tempRoot.path,
          `${cIdentifier}_${occurrence}.efi`,
        );
        let ghidraOutC: string | undefined;

        await writeFile(tempEfiPath, modBytes);
        try {
          if (input.include_disassembly) {
            const remainingAsmBytes =
              MAX_DISASSEMBLY_TOTAL_BYTES - totalStagedAsmBytes;
            if (remainingAsmBytes <= 0) {
              disassemblyStatus = "omitted";
              if (
                !effectiveLimitations.includes(
                  "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                )
              ) {
                effectiveLimitations.push(
                  "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                );
              }
            } else {
              const maxAsmBuffer = Math.min(
                MAX_DISASSEMBLY_MODULE_BYTES,
                remainingAsmBytes,
              );
              let asmOutput: string | null = null;
              let llvmErrorMsg: string | null = null;
              let objdumpErrorMsg: string | null = null;
              try {
                const { stdout } = await execFileOutput(
                  "llvm-objdump",
                  ["-d", "--no-show-raw-insn", tempEfiPath],
                  {
                    signal,
                    stopSignal: "SIGTERM",
                    timeout: 15_000,
                    maxBuffer: maxAsmBuffer,
                  },
                );
                asmOutput = stdout;
                asmGenerator = "llvm-objdump";
                disassemblyEngineUsed = "llvm-objdump";
              } catch (llvmError: unknown) {
                if (signal.aborted) signal.throwIfAborted();
                if (isAbortOf(llvmError, signal)) throw llvmError;
                llvmErrorMsg = errorMessage(llvmError);
                try {
                  const { stdout } = await execFileOutput(
                    "objdump",
                    ["-d", tempEfiPath],
                    {
                      signal,
                      stopSignal: "SIGTERM",
                      timeout: 15_000,
                      maxBuffer: maxAsmBuffer,
                    },
                  );
                  asmOutput = stdout;
                  asmGenerator = "objdump";
                  if (disassemblyEngineUsed === "none") {
                    disassemblyEngineUsed = "objdump";
                  }
                } catch (objdumpError: unknown) {
                  if (signal.aborted) signal.throwIfAborted();
                  if (isAbortOf(objdumpError, signal)) throw objdumpError;
                  objdumpErrorMsg = errorMessage(objdumpError);
                  asmOutput = null;
                }
              }
              if (asmOutput !== null) {
                const asmBytes = Buffer.from(asmOutput, "utf8");
                if (
                  totalStagedAsmBytes + asmBytes.length <=
                  MAX_DISASSEMBLY_TOTAL_BYTES
                ) {
                  const asmName = `${mod.cleanName}.asm`;
                  asmRelPath = `${moduleRelDir}/${asmName}`;
                  asmSha256 = sha256Hex(asmBytes);
                  publicationEntries.push({
                    relativePath: asmRelPath,
                    bytes: asmBytes,
                  });
                  totalStagedAsmBytes += asmBytes.length;
                  disassemblyStatus = "ok";
                } else {
                  disassemblyStatus = "omitted";
                  if (
                    !effectiveLimitations.includes(
                      "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                    )
                  ) {
                    effectiveLimitations.push(
                      "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                    );
                  }
                }
              } else {
                disassemblyStatus = "failed";
                const sanitizeDiag = (msg: string | null): string => {
                  if (msg === null) return "unknown";
                  const line = msg.replace(/[\r\n\t]+/g, " ").trim();
                  return ellipsisExcerpt(line, 120);
                };
                if (
                  recordedDisassemblyFailures <
                  MAX_DISASSEMBLY_FAILURE_DIAGNOSTICS
                ) {
                  effectiveLimitations.push(
                    `Disassembly for ${mod.rawName} failed: llvm-objdump (${sanitizeDiag(llvmErrorMsg)}), objdump (${sanitizeDiag(objdumpErrorMsg)})`,
                  );
                  recordedDisassemblyFailures++;
                } else if (
                  !effectiveLimitations.includes(
                    "Additional disassembly failure diagnostics omitted after reaching diagnostics budget.",
                  )
                ) {
                  effectiveLimitations.push(
                    "Additional disassembly failure diagnostics omitted after reaching diagnostics budget.",
                  );
                }
              }
            }
          }

          const cName = `${mod.cleanName}.c`;
          const cRelPath = `${moduleRelDir}/${cName}`;
          let cContent: string | null = null;
          let cGenerator: "ghidra" | "scaffold" = "scaffold";

          if (ghidraBin !== null) {
            const remainingCBytes =
              MAX_DECOMPILE_TOTAL_BYTES - totalStagedCBytes;
            if (remainingCBytes <= 0) {
              if (
                !effectiveLimitations.includes(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                )
              ) {
                effectiveLimitations.push(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                );
              }
            } else {
              ghidraOutC = join(
                tempRoot.path,
                `${cIdentifier}_${occurrence}_decompiled.c`,
              );
              try {
                const bridgeDir = resolve(
                  fileURLToPath(import.meta.url),
                  "..",
                  "..",
                  "bridge",
                  "ghidra",
                );
                const ghidraArgs = [
                  tempRoot.path,
                  `UefiDecomp_${cIdentifier}_${occurrence}`,
                  "-import",
                  tempEfiPath,
                  "-scriptPath",
                  bridgeDir,
                  "-postScript",
                  "ReaDecompileToC.java",
                  ghidraOutC,
                  "-deleteProject",
                ];
                let execCmd = ghidraBin;
                let execArgs = ghidraArgs;
                if (
                  HOST_PLATFORM.platform === "win32" &&
                  isWindowsBatchFile(ghidraBin)
                ) {
                  const batch = windowsBatchCommand({
                    environment: process.env,
                    batchPath: ghidraBin,
                    arguments: ghidraArgs,
                  });
                  execCmd = batch.command;
                  execArgs = [...batch.arguments];
                }
                await execFileOutput(execCmd, execArgs, {
                  signal,
                  stopSignal: "SIGTERM",
                  timeout: 45_000,
                  maxBuffer: 10 * 1024 * 1024,
                });
                if (existsSync(ghidraOutC)) {
                  const cStat = await stat(ghidraOutC);
                  const maxCBytes = Math.min(
                    MAX_DECOMPILE_MODULE_BYTES,
                    remainingCBytes,
                  );
                  if (cStat.size <= maxCBytes) {
                    const candidateC = await readFile(ghidraOutC, "utf8");
                    const candidateCBytes = Buffer.byteLength(
                      candidateC,
                      "utf8",
                    );
                    if (
                      totalStagedCBytes + candidateCBytes <=
                      MAX_DECOMPILE_TOTAL_BYTES
                    ) {
                      cContent = candidateC;
                      totalStagedCBytes += candidateCBytes;
                      cGenerator = "ghidra";
                    } else if (
                      !effectiveLimitations.includes(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      )
                    ) {
                      effectiveLimitations.push(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      );
                    }
                  } else if (
                    cStat.size > remainingCBytes &&
                    !effectiveLimitations.includes(
                      "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                    )
                  ) {
                    effectiveLimitations.push(
                      "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                    );
                  }
                }
              } catch (ghidraErr: unknown) {
                if (signal.aborted) signal.throwIfAborted();
                if (isAbortOf(ghidraErr, signal)) throw ghidraErr;
              }
            }
          }

          if (cContent === null) {
            cContent = [
              "/**",
              ` * Reconstructed Entry Scaffolding: ${mod.rawName}`,
              ` * Phase: ${mod.phase}${mod.typeName ? ` | Type: ${mod.typeName}` : ""}`,
              ` * GUID: ${mod.guid ?? "N/A"}`,
              " *",
              " * NOTE: This file is reconstructed entry point scaffolding for integration",
              " * and analysis. Native executable instructions reside in the accompanying",
              " * disassembly and binary payload.",
              " */",
              `#include "${headerName}"`,
              "",
              scaffold.functionDefinition,
              "",
            ].join("\n");
          }
          const cBytes = Buffer.from(cContent, "utf8");
          const cSha256 = sha256Hex(cBytes);
          publicationEntries.push({
            relativePath: cRelPath,
            bytes: cBytes,
          });

          stagedModules.push({
            occurrence,
            guid: mod.guid,
            name: mod.rawName,
            phase: mod.phase,
            disassembly_status: disassemblyStatus,
            relative_c_file: cRelPath,
            relative_asm_file: asmRelPath,
            relative_header_file: headerRelPath,
            relative_payload_file: relativePayloadFile,
            c_sha256: cSha256,
            asm_sha256: asmSha256,
            header_sha256: headerSha256,
            payload_sha256: payloadSha256,
            c_generator: cGenerator,
            asm_generator: asmGenerator,
            code_bytes: modBytes.length,
          });
        } finally {
          // Remove each module's temporary scratch files immediately
          try {
            await rm(tempEfiPath, { force: true });
            if (ghidraOutC !== undefined) {
              await rm(ghidraOutC, { force: true });
            }
          } catch {
            // Ignore scratch unlink error
          }
        }
      }

      const manifestData = {
        image_sha256: imageSha256,
        total_modules_found: discoveredModules.length,
        total_modules_decompiled: stagedModules.length,
        phases: phaseCounts,
        limitations: effectiveLimitations,
        modules: stagedModules.map((m) => ({
          ...m,
          c_file: m.relative_c_file,
          asm_file: m.relative_asm_file,
          header_file: m.relative_header_file,
          payload_file: m.relative_payload_file,
        })),
      };
      publicationEntries.push({
        relativePath: "firmware_manifest.json",
        bytes: Buffer.from(JSON.stringify(manifestData, null, 2), "utf8"),
      });

      const readmeLines = [
        "# Decompiled UEFI Firmware Source Tree",
        "",
        `- **Image / Corpus SHA-256**: \`${imageSha256}\``,
        `- **Total Modules Found**: ${discoveredModules.length}`,
        `- **Total Modules Decompiled**: ${stagedModules.length}`,
        "",
        "## Phases",
        `- **SEC** (Security Core): ${phaseCounts.sec}`,
        `- **PEI** (Pre-EFI Initialization): ${phaseCounts.pei}`,
        `- **DXE** (Driver Execution Environment): ${phaseCounts.dxe}`,
        `- **SMM** (System Management Mode): ${phaseCounts.smm}`,
        `- **APP** (UEFI Applications): ${phaseCounts.app}`,
        `- **MISC**: ${phaseCounts.misc}`,
        ...(effectiveLimitations.length > 0
          ? ["", "## Limitations", ...effectiveLimitations.map((l) => `- ${l}`)]
          : []),
        "",
        "## Modules Index",
        "| Phase | Name | GUID | Size (Bytes) | Disassembly Status | C Scaffold | Disassembly |",
        "|---|---|---|---|---|---|---|",
        ...stagedModules.map(
          (m) =>
            `| ${m.phase} | \`${m.name}\` | \`${m.guid ?? "N/A"}\` | ${m.code_bytes} | ${m.disassembly_status} | [${m.name}.c](${m.relative_c_file}) | ${m.relative_asm_file ? `[${m.name}.asm](${m.relative_asm_file})` : "N/A"} |`,
        ),
      ];
      publicationEntries.push({
        relativePath: "README.md",
        bytes: Buffer.from(readmeLines.join("\n"), "utf8"),
      });

      const publication = await publishUefiFiles<UefiDecompileResult>({
        outputDirectory: input.output_directory,
        operation: request.operation,
        entries: publicationEntries,
        signal,
        checkpoint,
        resources: this.#resources,
        buildResult: (outputRoot, _files, receipts) => {
          const receiptsByRelPath = new Map<string, UefiWriteReceipt>(
            receipts.map((r) => [r.relativePath, r]),
          );
          const finalModules = stagedModules.map((m) => {
            const cReceipt = receiptsByRelPath.get(m.relative_c_file);
            const asmReceipt =
              m.relative_asm_file !== null
                ? receiptsByRelPath.get(m.relative_asm_file)
                : undefined;
            const headerReceipt = receiptsByRelPath.get(m.relative_header_file);
            const payloadReceipt =
              m.relative_payload_file !== null
                ? receiptsByRelPath.get(m.relative_payload_file)
                : undefined;

            return {
              ...m,
              c_file:
                cReceipt !== undefined
                  ? cReceipt.path
                  : join(outputRoot, m.relative_c_file),
              c_sha256: cReceipt?.sha256 ?? m.c_sha256,
              asm_file:
                asmReceipt !== undefined
                  ? asmReceipt.path
                  : m.relative_asm_file !== null
                    ? join(outputRoot, m.relative_asm_file)
                    : null,
              asm_sha256: asmReceipt?.sha256 ?? m.asm_sha256,
              header_file:
                headerReceipt !== undefined
                  ? headerReceipt.path
                  : join(outputRoot, m.relative_header_file),
              header_sha256: headerReceipt?.sha256 ?? m.header_sha256,
              payload_file:
                payloadReceipt !== undefined
                  ? payloadReceipt.path
                  : m.relative_payload_file !== null
                    ? join(outputRoot, m.relative_payload_file)
                    : null,
              payload_sha256: payloadReceipt?.sha256 ?? m.payload_sha256,
            };
          });

          return uefiResultSchemas.decompile_uefi_firmware.parse({
            parser: {
              name: "rea-uefi",
              version: UEFI_PROVIDER_IDENTITY.version,
            },
            image_sha256: imageSha256,
            output_directory: outputRoot,
            total_modules_found: discoveredModules.length,
            total_modules_decompiled: stagedModules.length,
            phases: phaseCounts,
            modules: finalModules,
            producers: {
              ghidra: ghidraBin,
              disassembler: input.include_disassembly
                ? disassemblyEngineUsed
                : "none",
            },
            receipts: receipts.map((r) => ({
              relative_path: r.relativePath,
              path: r.path,
              size: r.size,
              sha256: r.sha256,
            })),
            diagnostics: `Successfully published ${stagedModules.length} decompiled UEFI module(s) across phases into ${outputRoot}.`,
            limitations: effectiveLimitations,
          });
        },
      });

      const { result } = publication;
      publishedResult = result;
      if (publication.failure !== undefined) {
        throw publication.failure.retainPartialObservation({
          kind: "uefi",
          result: jsonValueSchema.parse(result),
          provenance: {
            path: input.path,
            sha256: imageSha256,
          },
        });
      }

      return createAnalysisExecution(result, UEFI_PROVIDER_IDENTITY, {
        subject: { path: input.path, sha256: imageSha256, format },
        locations: [{ kind: "artifact-path", path: input.path }],
        limitations: effectiveLimitations,
      });
    } catch (cause: unknown) {
      establishedError = cause;
      throw cause;
    } finally {
      try {
        await tempRoot.close();
      } catch {
        this.#resources.retain({
          kind: "private-runtime-root",
          resource: tempRoot.path,
          root: tempRoot,
        });
      }
      if (signal.aborted) {
        const partialObservation =
          publishedResult !== undefined
            ? {
                kind: "uefi" as const,
                result: jsonValueSchema.parse(publishedResult),
                provenance: {
                  path: input.path,
                  sha256: imageSha256,
                },
              }
            : undefined;

        const terminationError: AnalysisError =
          signal.reason instanceof AnalysisTimeoutError
            ? new AnalysisTimeoutError(
                "decompile_uefi_firmware",
                signal.reason.timeoutMs,
                {
                  cause: signal.reason,
                  partialObservation,
                },
              )
            : cancelledBy("decompile_uefi_firmware", signal, {
                partialObservation,
              });

        if (establishedError instanceof AnalysisError) {
          if (terminationError instanceof AnalysisCancelledError) {
            throw analysisErrorWithCancellation(
              establishedError,
              terminationError,
            );
          }
          establishedError.retainSecondaryFailure(terminationError);
          throw establishedError;
        }
        if (establishedError === undefined) {
          throw terminationError;
        }
      }
    }
  }

  async #decompileFirmware(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    imageSha256: string,
    scan: UefiImageScanSummary,
    signal: AbortSignal,
    checkpoint: () => void,
  ): Promise<AnalysisExecution> {
    const discoveredModules: DiscoveredUefiModule[] = [];
    const seenSections = new Set<string>();

    for (const volume of scan.volumes) {
      for (const file of volume.ffs_files) {
        checkpoint();
        signal.throwIfAborted();

        for (const section of file.sections) {
          if (section.type_code === 0x10 || section.type_code === 0x12) {
            const payload = scan.payloads.get(section.logical_path);
            if (payload !== undefined && payload.bytes.length > 0) {
              const dedupeKey = `${file.guid}_${section.logical_path}`;
              if (seenSections.has(dedupeKey)) continue;
              seenSections.add(dedupeKey);

              const rawName =
                file.ui_string ?? `Module_${file.guid.slice(0, 8)}`;
              const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

              let phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC" = "DXE";
              if (file.type_name === "security-core") phase = "SEC";
              else if (file.type_name.includes("pei")) phase = "PEI";
              else if (
                file.type_name.includes("smm") ||
                file.type_name.includes("mm-")
              )
                phase = "SMM";
              else if (file.type_name === "application") phase = "APP";
              else if (
                file.type_name === "driver" ||
                file.type_name === "dxe-core"
              )
                phase = "DXE";
              else phase = "MISC";

              const requested = request.input.filter_phase.toLowerCase();
              const isCombinedPeimDriver =
                file.type_name === "combined-peim-driver";
              const isCombinedSmmDxe = file.type_name === "combined-smm-dxe";
              const matchesPhase =
                requested === "all" ||
                phase.toLowerCase() === requested ||
                (requested === "dxe" &&
                  (isCombinedPeimDriver || isCombinedSmmDxe)) ||
                (requested === "pei" && isCombinedPeimDriver) ||
                (requested === "smm" && isCombinedSmmDxe);

              if (matchesPhase) {
                discoveredModules.push({
                  guid: file.guid,
                  rawName,
                  cleanName,
                  typeName: file.type_name,
                  phase,
                  bytes: payload.bytes,
                  byteLength: payload.bytes.length,
                });
              }
            }
          }
        }
      }
    }

    return this.#stageAndPublishModules(
      request,
      imageSha256,
      discoveredModules,
      scan.limitations,
      signal,
      checkpoint,
      "file",
    );
  }

  async #decompileDirectory(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    signal: AbortSignal,
    checkpoint: () => void,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const dirEntries = await readdir(input.path, {
      withFileTypes: true,
      recursive: true,
    });
    const guidRegex =
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

    interface CandidateModule {
      readonly fullPath: string;
      readonly normRelPath: string;
      readonly name: string;
      readonly size: number;
      readonly phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC";
      readonly guid: string | null;
      readonly rawName: string;
      readonly cleanName: string;
    }
    const candidates: CandidateModule[] = [];

    for (const entry of dirEntries) {
      checkpoint();
      signal.throwIfAborted();
      if (!entry.isFile()) continue;

      const parent = entry.parentPath ?? input.path;
      const fullPath = join(parent, entry.name);

      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }
      if (fileStat.size <= 0 || fileStat.size > 32 * 1024 * 1024) continue;

      let isPeOrTe = false;
      let owner: OwnedFileHandle | undefined;
      try {
        const rawHandle = await open(fullPath, "r");
        owner = new OwnedFileHandle(rawHandle);
        const headerBuf = Buffer.alloc(64);
        const { bytesRead } = await owner.handle.read(headerBuf, 0, 64, 0);
        if (bytesRead >= 2) {
          const isPe = headerBuf[0] === 0x4d && headerBuf[1] === 0x5a; // MZ
          const isTe = headerBuf[0] === 0x56 && headerBuf[1] === 0x5a; // VZ
          isPeOrTe = isPe || isTe;
        }
      } catch {
        continue;
      } finally {
        if (owner !== undefined) {
          try {
            await owner.close();
          } catch {
            this.#resources.retain({
              kind: "file-handle",
              resource: fullPath,
              handle: owner,
            });
          }
        }
      }
      if (!isPeOrTe) continue;

      const relPath = relative(input.path, fullPath);
      const normRelPath = relPath.split(/[/\\]+/).join("/");
      const segments = normRelPath.toLowerCase().split("/");
      let phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC" = "DXE";
      if (segments.some((s) => s === "sec")) phase = "SEC";
      else if (segments.some((s) => s === "pei" || s === "peim")) phase = "PEI";
      else if (segments.some((s) => s === "smm")) phase = "SMM";
      else if (segments.some((s) => s === "app" || s === "application"))
        phase = "APP";

      if (
        input.filter_phase !== "all" &&
        phase.toLowerCase() !== input.filter_phase.toLowerCase()
      ) {
        continue;
      }

      const guidMatch = entry.name.match(guidRegex);
      const guid =
        guidMatch && guidMatch[1] ? guidMatch[1].toLowerCase() : null;
      const rawName = entry.name.replace(/\.(pe|efi|bin|te)$/i, "");
      const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

      candidates.push({
        fullPath,
        normRelPath,
        name: entry.name,
        size: fileStat.size,
        phase,
        guid,
        rawName,
        cleanName,
      });
    }

    // Sort candidates deterministically by Unicode code point order (locale-independent)
    candidates.sort((a, b) =>
      compareUnicodeCodePoints(a.normRelPath, b.normRelPath),
    );

    const dirHash = createHash("sha256");
    const discoveredModules: DiscoveredUefiModule[] = [];

    for (const candidate of candidates) {
      checkpoint();
      signal.throwIfAborted();
      const content = await readFile(candidate.fullPath);
      const fileSha256 = sha256Hex(content);
      dirHash.update(compositeKey([candidate.normRelPath, fileSha256]) + "\n");
      discoveredModules.push({
        guid: candidate.guid,
        rawName: candidate.rawName,
        cleanName: candidate.cleanName,
        phase: candidate.phase,
        sourcePath: candidate.fullPath,
        byteLength: candidate.size,
      });
    }

    const dirSha256 =
      candidates.length === 0
        ? sha256Hex(Buffer.alloc(0))
        : dirHash.digest("hex");

    return this.#stageAndPublishModules(
      request,
      dirSha256,
      discoveredModules,
      [],
      signal,
      checkpoint,
      "directory",
    );
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
        const { buffer: bytes, consumedBytes } = nodeCodecResult(
          await inflateBounded(payload, {
            info: true,
            maxOutputLength: maxOutputBytes,
          }),
        );
        if (consumedBytes !== payload.length)
          return {
            ok: false,
            reason: "format",
            message: `AMD zlib stream used ${consumedBytes} of ${payload.length} declared compressed bytes.`,
          };
        return {
          ok: true,
          outcome: {
            bytes,
            decoderVersion: process.versions.zlib ?? "unknown",
            consumedBytes,
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
      const consumedBytes = reply.input_bytes_consumed;
      if (consumedBytes > payload.length) {
        return {
          ok: false,
          reason: "decoder",
          message: `LZMA worker reported consuming ${consumedBytes} bytes from a ${payload.length}-byte input.`,
        };
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
          consumedBytes,
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
