import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import { decodePeMachine } from "../domain/peMachine.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import type { UefiDecodeFormat } from "./FfsSections.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { hostRangeErrorKind } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { basename, join, relative, resolve } from "node:path";
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
import {
  analysisErrorWithCleanupDependencies,
  analysisErrorWithCleanupFailure,
} from "../domain/analysisErrorCleanup.js";
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
  readonly typeName?: string | undefined;
  readonly bytes?: Buffer | undefined;
  readonly sourcePath?: string | undefined;
  readonly byteLength: number;
}

interface UefiEntryPointScaffolding {
  readonly typedefs: readonly string[];
  readonly prototype: string;
  readonly functionDefinition: string;
}

export type UefiMachineWidth = "32" | "64";

export const sanitizeCComment = (text: string): string =>
  text
    .replace(/\*\//g, "* /")
    .replace(/[\r\n]+/g, " ")
    .trim();

export const detectPeTeMachineWidth = (bytes: Buffer): UefiMachineWidth => {
  if (bytes.length < 4) {
    return "64";
  }

  try {
    const reader = new BinaryReader(bytes, true, "UEFI image header");
    let candidateMachine: number | undefined;

    // 1. Check for TE header (Signature "VZ" = 0x56, 0x5A)
    if (bytes[0] === 0x56 && bytes[1] === 0x5a && bytes.length >= 4) {
      candidateMachine = reader.u16(2);
    }
    // 2. Check for PE header ("MZ" DOS header followed by PE signature at e_lfanew)
    else if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 0x40) {
      const eLfanew = reader.u32(0x3c);
      if (eLfanew + 6 <= bytes.length) {
        if (
          bytes[eLfanew] === 0x50 &&
          bytes[eLfanew + 1] === 0x45 &&
          bytes[eLfanew + 2] === 0x00 &&
          bytes[eLfanew + 3] === 0x00
        ) {
          candidateMachine = reader.u16(eLfanew + 4);
        }
      }
    }
    // 3. Direct COFF header without DOS stub
    else if (
      bytes.length >= 6 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x45 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00
    ) {
      candidateMachine = reader.u16(4);
    }

    if (candidateMachine !== undefined) {
      const decoded = decodePeMachine(candidateMachine);
      if (decoded !== undefined) {
        return decoded.architecture === "x86_64" ||
          decoded.architecture === "arm64"
          ? "64"
          : "32";
      }
      if (candidateMachine === 0x5032 || candidateMachine === 0x0ebc) {
        return "32";
      }
      if (candidateMachine === 0x5064 || candidateMachine === 0x5128) {
        return "64";
      }
    }
  } catch {
    return "64";
  }

  return "64";
};

export const buildUefiEntryPointScaffolding = (
  identifier: string,
  rawName: string,
  byteLength: number,
  phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC",
  typeName?: string,
  machineWidth: UefiMachineWidth = "64",
): UefiEntryPointScaffolding => {
  const safeName = sanitizeCComment(rawName);
  const statusType = machineWidth === "32" ? "uint32_t" : "uint64_t";
  const normType = typeName?.toLowerCase();
  if (normType === "pei-core") {
    return {
      typedefs: [
        "struct _EFI_SEC_PEI_HAND_OFF;",
        "typedef struct _EFI_SEC_PEI_HAND_OFF EFI_SEC_PEI_HAND_OFF;",
        "struct _EFI_PEI_PPI_DESCRIPTOR;",
        "typedef struct _EFI_PEI_PPI_DESCRIPTOR EFI_PEI_PPI_DESCRIPTOR;",
      ],
      prototype: `void EFIAPI ${identifier}EntryPoint(const EFI_SEC_PEI_HAND_OFF *SecCoreData, const EFI_PEI_PPI_DESCRIPTOR *PpiList, void *Context);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        "    const EFI_SEC_PEI_HAND_OFF *SecCoreData,",
        "    const EFI_PEI_PPI_DESCRIPTOR *PpiList,",
        "    void *Context",
        ") {",
        `    // Reconstructed PEI Core EntryPoint scaffolding for ${safeName}`,
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
        `typedef ${statusType} EFI_STATUS;`,
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
        `    // Reconstructed PEIM EntryPoint scaffolding for ${safeName}`,
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
        `    // Reconstructed SEC EntryPoint scaffolding for ${safeName}`,
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
        `    // Reconstructed DXE Core EntryPoint scaffolding for ${safeName}`,
        `    // Size: ${byteLength} bytes`,
        "    (void)HobStart;",
        "}",
      ].join("\n"),
    };
  }

  return {
    typedefs: [
      `typedef ${statusType} EFI_STATUS;`,
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
      `    // Reconstructed EntryPoint scaffolding for ${safeName}`,
      `    // Size: ${byteLength} bytes`,
      "    EFI_STATUS Status = EFI_SUCCESS;",
      "    (void)ImageHandle;",
      "    (void)SystemTable;",
      "    return Status;",
      "}",
    ].join("\n"),
  };
};

const isBufferLimitExceeded = (err: unknown): boolean => {
  if (hostRangeErrorKind(err) === "host-capacity") {
    return true;
  }
  if (err instanceof Error && err.message.includes("maxBuffer")) {
    return true;
  }
  const code = (err as { code?: unknown })?.code;
  return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
};

const resolveGhidraHeadless = (): string | null => {
  const isWindows = HOST_PLATFORM.platform === "win32";
  const headlessName = isWindows ? "analyzeHeadless.bat" : "analyzeHeadless";

  // An explicit setting remains authoritative even when malformed or stale;
  // automatic discovery is only a fallback when the caller supplied none.
  const envDir = process.env.GHIDRA_INSTALL_DIR;
  if (typeof envDir === "string" && envDir.trim().length > 0) {
    const candidate = join(envDir, "support", headlessName);
    const properties = join(envDir, "Ghidra", "application.properties");
    if (existsSync(candidate) && existsSync(properties)) {
      return candidate;
    }
    // Explicit setting was provided but is invalid or stale: do not fall back.
    return null;
  }

  // Fallback discovery only when no explicit setting was provided
  const pathEnv = process.env.PATH ?? "";
  const pathDirs = pathEnv
    .split(isWindows ? ";" : ":")
    .filter((p) => p.length > 0);
  for (const dir of pathDirs) {
    const directHeadless = join(dir, headlessName);
    if (existsSync(directHeadless)) return directHeadless;

    const subHeadless = join(dir, "support", headlessName);
    if (existsSync(subHeadless)) return subHeadless;

    const ghidraRunName = isWindows ? "ghidraRun.bat" : "ghidraRun";
    const ghidraRun = join(dir, ghidraRunName);
    if (existsSync(ghidraRun)) {
      const fromGhidraRun = join(dir, "support", headlessName);
      if (existsSync(fromGhidraRun)) return fromGhidraRun;
    }
  }

  const systemCandidates = ["/opt/ghidra", "/usr/share/ghidra"];
  for (const root of systemCandidates) {
    const candidate = join(root, "support", headlessName);
    const properties = join(root, "Ghidra", "application.properties");
    if (existsSync(candidate) && existsSync(properties)) {
      return candidate;
    }
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
    const remainingTimeMs = (): number =>
      Math.max(0, deadline - performance.now());
    try {
      return {
        ok: true,
        value: await this.#executeWithSignal(
          request,
          controller.signal,
          checkpoint,
          remainingTimeMs,
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
    remainingTimeMs?: () => number,
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
        return await this.#decompileDirectory(
          request,
          signal,
          checkpoint,
          remainingTimeMs,
        );
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
          remainingTimeMs,
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
    remainingTimeMs?: () => number,
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
    const MAX_GHIDRA_FAILURE_DIAGNOSTICS = 20;
    let recordedGhidraFailures = 0;
    let totalStagedCBytes = 0;

    const sanitizeDiag = (msg: string | null): string => {
      if (msg === null) return "unknown";
      const line = msg.replace(/[\r\n\t]+/g, " ").trim();
      return ellipsisExcerpt(line, 120);
    };

    const MAX_RAW_PAYLOAD_TOTAL_BYTES = 128 * 1024 * 1024;
    let totalStagedRawBytes = 0;

    let publishedResult: UefiDecompileResult | undefined;
    let establishedError: unknown;

    try {
      const allocatedRelDirs = new Set<string>();
      let moduleSeq = 0;
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

        // Reserve time to finalize completed modules and publish them before the deadline
        const PUBLICATION_RESERVE_MS = 5_000;
        if (remainingTimeMs !== undefined && stagedModules.length > 0) {
          const timeLeft = remainingTimeMs();
          if (timeLeft <= PUBLICATION_RESERVE_MS) {
            effectiveLimitations.push(
              `Decompilation halted early to finalize and publish ${stagedModules.length} completed modules before operation deadline.`,
            );
            break;
          }
        }

        moduleSeq++;
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

        const idPrefix =
          mod.guid ?? `noguid_${sha256Hex(modBytes).slice(0, 8)}`;
        const maxCleanNameLen = 160;
        const boundedRawCleanName = mod.cleanName.slice(0, maxCleanNameLen);
        const WINDOWS_RESERVED_DEVICE_NAMES =
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
        const boundedName = WINDOWS_RESERVED_DEVICE_NAMES.test(
          boundedRawCleanName,
        )
          ? `_${boundedRawCleanName}`
          : boundedRawCleanName;
        let moduleRelDir = `${mod.phase}/${idPrefix}_${boundedName}`;
        let occurrence = 0;
        while (allocatedRelDirs.has(moduleRelDir)) {
          occurrence++;
          moduleRelDir = `${mod.phase}/${idPrefix}_${boundedName}_${occurrence}`;
        }
        allocatedRelDirs.add(moduleRelDir);

        const efiRelPath = `${moduleRelDir}/${boundedName}.efi`;
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

        const machineWidth = detectPeTeMachineWidth(modBytes);
        const scaffold = buildUefiEntryPointScaffolding(
          cIdentifier,
          mod.rawName,
          modBytes.length,
          mod.phase,
          mod.typeName,
          machineWidth,
        );

        const safeRawName = sanitizeCComment(mod.rawName);
        const safeTypeName = mod.typeName
          ? sanitizeCComment(mod.typeName)
          : null;
        const safeGuid = mod.guid ? sanitizeCComment(mod.guid) : null;

        const headerName = `${boundedName}.h`;
        const headerRelPath = `${moduleRelDir}/${headerName}`;
        const headerGuard = `_UEFI_${cIdentifier.toUpperCase()}_H_`;
        const headerContent = [
          "/**",
          ` * UEFI Module Header: ${safeRawName}`,
          ` * Phase: ${mod.phase}${safeTypeName ? ` | Type: ${safeTypeName}` : ""}`,
          ` * GUID: ${safeGuid ?? "N/A"}`,
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
          "#elif defined(__x86_64__) || defined(__amd64__)",
          "#define EFIAPI __attribute__((ms_abi))",
          "#else",
          "#define EFIAPI",
          "#endif",
          "#endif",
          "",
          ...scaffold.typedefs,
          ...(mod.guid
            ? [
                `#define ${cIdentifier.toUpperCase()}_GUID "${mod.guid.replace(/["\\]/g, "")}"`,
              ]
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
        const tempEfiPath = join(tempRoot.path, `mod_${moduleSeq}.efi`);
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
              const timeLeftForDisasm =
                remainingTimeMs !== undefined
                  ? Math.floor(remainingTimeMs() - PUBLICATION_RESERVE_MS)
                  : 15_000;
              if (timeLeftForDisasm <= 0) {
                disassemblyStatus = "omitted";
                if (
                  !effectiveLimitations.includes(
                    "Disassembly omitted for remaining modules to preserve deadline for publication.",
                  )
                ) {
                  effectiveLimitations.push(
                    "Disassembly omitted for remaining modules to preserve deadline for publication.",
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
                let llvmError: unknown;
                let objdumpError: unknown;
                const disasmTimeout = Math.floor(
                  Math.min(15_000, Math.max(500, timeLeftForDisasm)),
                );
                try {
                  const { stdout } = await execFileOutput(
                    "llvm-objdump",
                    ["-d", "--no-show-raw-insn", tempEfiPath],
                    {
                      signal,
                      stopSignal: "SIGTERM",
                      timeout: disasmTimeout,
                      maxBuffer: maxAsmBuffer,
                    },
                  );
                  asmOutput = stdout;
                  asmGenerator = "llvm-objdump";
                  disassemblyEngineUsed = "llvm-objdump";
                } catch (err: unknown) {
                  if (signal.aborted) signal.throwIfAborted();
                  if (isAbortOf(err, signal)) throw err;
                  llvmError = err;
                  llvmErrorMsg = errorMessage(err);
                  const remainingForObjdump =
                    remainingTimeMs !== undefined
                      ? Math.floor(remainingTimeMs() - PUBLICATION_RESERVE_MS)
                      : 15_000;
                  if (remainingForObjdump > 0) {
                    const objdumpTimeout = Math.floor(
                      Math.min(15_000, Math.max(500, remainingForObjdump)),
                    );
                    try {
                      const { stdout } = await execFileOutput(
                        "objdump",
                        ["-d", tempEfiPath],
                        {
                          signal,
                          stopSignal: "SIGTERM",
                          timeout: objdumpTimeout,
                          maxBuffer: maxAsmBuffer,
                        },
                      );
                      asmOutput = stdout;
                      asmGenerator = "objdump";
                      if (disassemblyEngineUsed === "none") {
                        disassemblyEngineUsed = "objdump";
                      }
                    } catch (err2: unknown) {
                      if (signal.aborted) signal.throwIfAborted();
                      if (isAbortOf(err2, signal)) throw err2;
                      objdumpError = err2;
                      objdumpErrorMsg = errorMessage(err2);
                      asmOutput = null;
                    }
                  } else {
                    asmOutput = null;
                  }
                }
                if (asmOutput !== null) {
                  const asmBytes = Buffer.from(asmOutput, "utf8");
                  if (
                    totalStagedAsmBytes + asmBytes.length <=
                    MAX_DISASSEMBLY_TOTAL_BYTES
                  ) {
                    const asmName = `${boundedName}.asm`;
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
                  if (
                    isBufferLimitExceeded(llvmError) ||
                    isBufferLimitExceeded(objdumpError)
                  ) {
                    disassemblyStatus = "omitted";
                    if (maxAsmBuffer < remainingAsmBytes) {
                      const perModLimit = `Disassembly output for ${mod.rawName} exceeded 2 MiB module budget; omitted disassembly.`;
                      if (!effectiveLimitations.includes(perModLimit)) {
                        effectiveLimitations.push(perModLimit);
                      }
                    } else if (
                      !effectiveLimitations.includes(
                        "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                      )
                    ) {
                      effectiveLimitations.push(
                        "Disassembly output truncated after reaching 64 MiB aggregate staging budget.",
                      );
                    }
                  } else {
                    disassemblyStatus = "failed";
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
            }
          }

          const cName = `${boundedName}.c`;
          const cRelPath = `${moduleRelDir}/${cName}`;
          let cContent: string | null = null;
          let cGenerator: "ghidra" | "scaffold" = "scaffold";

          if (ghidraBin !== null) {
            const remainingCBytes =
              MAX_DECOMPILE_TOTAL_BYTES - totalStagedCBytes;
            const timeLeftForGhidra =
              remainingTimeMs !== undefined
                ? Math.floor(remainingTimeMs() - PUBLICATION_RESERVE_MS)
                : 45_000;
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
            } else if (timeLeftForGhidra <= 1_000) {
              const ghidraSkipMsg = `Ghidra C decompilation for ${mod.rawName} omitted to preserve deadline for publication; generated entry point scaffolding instead.`;
              if (!effectiveLimitations.includes(ghidraSkipMsg)) {
                effectiveLimitations.push(ghidraSkipMsg);
              }
            } else {
              const ghidraTimeout = Math.floor(
                Math.min(45_000, Math.max(1_000, timeLeftForGhidra)),
              );
              ghidraOutC = join(tempRoot.path, `mod_${moduleSeq}_decompiled.c`);
              try {
                const bridgeDir = fileURLToPath(
                  new URL("../../bridge/ghidra", import.meta.url),
                );
                const scriptPath = join(bridgeDir, "ReaDecompileToC.java");
                const ghidraHome = join(tempRoot.path, "ghidra_home");
                const ghidraConfig = join(tempRoot.path, "ghidra_config");
                const ghidraTemp = join(tempRoot.path, "ghidra_temp");
                await Promise.all([
                  mkdir(ghidraHome, { recursive: true }),
                  mkdir(ghidraConfig, { recursive: true }),
                  mkdir(ghidraTemp, { recursive: true }),
                ]);
                const ghidraEnv: NodeJS.ProcessEnv = {
                  ...process.env,
                  _JAVA_OPTIONS: "",
                  JAVA_TOOL_OPTIONS: "",
                  JDK_JAVA_OPTIONS: "",
                  GHIDRA_JAVA_OPTIONS: "",
                  HOME: ghidraHome,
                  TMPDIR: ghidraTemp,
                  XDG_CONFIG_HOME: ghidraConfig,
                  XDG_CACHE_HOME: ghidraTemp,
                  XDG_DATA_HOME: ghidraHome,
                  ...(HOST_PLATFORM.platform === "win32"
                    ? {
                        USERPROFILE: ghidraHome,
                        APPDATA: ghidraConfig,
                        LOCALAPPDATA: ghidraTemp,
                        TEMP: ghidraTemp,
                        TMP: ghidraTemp,
                      }
                    : {}),
                };
                const ghidraArgs = [
                  tempRoot.path,
                  `UefiDecomp_${moduleSeq}`,
                  "-import",
                  tempEfiPath,
                  "-scriptPath",
                  bridgeDir,
                  "-postScript",
                  scriptPath,
                  ghidraOutC,
                  String(Math.min(MAX_DECOMPILE_MODULE_BYTES, remainingCBytes)),
                  "-deleteProject",
                ];
                let execCmd = ghidraBin;
                let execArgs = ghidraArgs;
                if (
                  HOST_PLATFORM.platform === "win32" &&
                  isWindowsBatchFile(ghidraBin)
                ) {
                  const batch = windowsBatchCommand({
                    environment: ghidraEnv,
                    batchPath: ghidraBin,
                    arguments: ghidraArgs,
                  });
                  execCmd = batch.command;
                  execArgs = [...batch.arguments];
                }
                await execFileOutput(execCmd, execArgs, {
                  signal,
                  stopSignal: "SIGTERM",
                  timeout: ghidraTimeout,
                  maxBuffer: 10 * 1024 * 1024,
                  env: ghidraEnv,
                });
                if (existsSync(ghidraOutC)) {
                  const cStat = await stat(ghidraOutC);
                  if (cStat.size > remainingCBytes) {
                    if (
                      !effectiveLimitations.includes(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      )
                    ) {
                      effectiveLimitations.push(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      );
                    }
                  } else if (cStat.size > MAX_DECOMPILE_MODULE_BYTES) {
                    const perModuleLimit = `Decompiled C output for ${mod.rawName} exceeded 4 MiB module budget (${cStat.size} bytes); generated entry point scaffolding instead.`;
                    if (!effectiveLimitations.includes(perModuleLimit)) {
                      effectiveLimitations.push(perModuleLimit);
                    }
                  } else {
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
                      if (
                        candidateC.includes(
                          "/* WARNING: Failed to decompile function",
                        )
                      ) {
                        const incompleteMsg = `Ghidra C decompilation for ${mod.rawName} was incomplete; one or more functions failed to decompile.`;
                        if (!effectiveLimitations.includes(incompleteMsg)) {
                          effectiveLimitations.push(incompleteMsg);
                        }
                      }
                    } else if (
                      !effectiveLimitations.includes(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      )
                    ) {
                      effectiveLimitations.push(
                        "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                      );
                    }
                  }
                } else {
                  const noOutputMsg = `Ghidra C decompilation for ${mod.rawName} failed: decompilation script produced no output.`;
                  if (recordedGhidraFailures < MAX_GHIDRA_FAILURE_DIAGNOSTICS) {
                    effectiveLimitations.push(noOutputMsg);
                    recordedGhidraFailures++;
                  } else if (
                    !effectiveLimitations.includes(
                      "Additional Ghidra decompilation failure diagnostics omitted after reaching diagnostics budget.",
                    )
                  ) {
                    effectiveLimitations.push(
                      "Additional Ghidra decompilation failure diagnostics omitted after reaching diagnostics budget.",
                    );
                  }
                }
              } catch (ghidraErr: unknown) {
                if (signal.aborted) signal.throwIfAborted();
                if (isAbortOf(ghidraErr, signal)) throw ghidraErr;
                const errDetail = sanitizeDiag(errorMessage(ghidraErr));
                if (recordedGhidraFailures < MAX_GHIDRA_FAILURE_DIAGNOSTICS) {
                  effectiveLimitations.push(
                    `Ghidra C decompilation for ${mod.rawName} failed: ${errDetail}`,
                  );
                  recordedGhidraFailures++;
                } else if (
                  !effectiveLimitations.includes(
                    "Additional Ghidra decompilation failure diagnostics omitted after reaching diagnostics budget.",
                  )
                ) {
                  effectiveLimitations.push(
                    "Additional Ghidra decompilation failure diagnostics omitted after reaching diagnostics budget.",
                  );
                }
              }
            }
          }

          if (cContent === null) {
            cContent = [
              "/**",
              ` * Reconstructed Entry Scaffolding: ${safeRawName}`,
              ` * Phase: ${mod.phase}${safeTypeName ? ` | Type: ${safeTypeName}` : ""}`,
              ` * GUID: ${safeGuid ?? "N/A"}`,
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
        ...stagedModules.map((m) => {
          const safeCellName = m.name
            .replace(/[\r\n]+/g, " ")
            .replace(/\|/g, "\\|")
            .replace(/`/g, "\\`");
          const safeLinkName = m.name
            .replace(/[\r\n]+/g, " ")
            .replace(/[[\]|`]/g, "_");
          return `| ${m.phase} | \`${safeCellName}\` | \`${m.guid ?? "N/A"}\` | ${m.code_bytes} | ${m.disassembly_status} | [${safeLinkName}.c](${m.relative_c_file}) | ${m.relative_asm_file ? `[${safeLinkName}.asm](${m.relative_asm_file})` : "N/A"} |`;
        }),
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
      const released = await this.#resources.release({
        kind: "private-runtime-root",
        resource: tempRoot.path,
        root: tempRoot,
      });

      let cleanupError: ProviderCleanupError | undefined;
      if (released.kind === "failed") {
        const completedObservation =
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
        cleanupError = new ProviderCleanupError(
          UEFI_PROVIDER_IDENTITY.id,
          released.lease.cleanupResources ?? [tempRoot.path],
          { reason: errorMessage(released.cause) },
          {
            cause: released.cause,
            operation: "decompile_uefi_firmware",
            ...(completedObservation === undefined
              ? {}
              : { completedObservation }),
          },
        );
        new AnalysisCleanupLeaseGroup(cleanupError, [released.lease]);
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

        let terminationError: AnalysisError =
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

        if (cleanupError !== undefined) {
          terminationError = analysisErrorWithCleanupDependencies(
            terminationError,
            cleanupError,
            "decompile_uefi_firmware",
          );
        }

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

      if (
        establishedError instanceof AnalysisError &&
        cleanupError !== undefined
      ) {
        throw analysisErrorWithCleanupDependencies(
          establishedError,
          cleanupError,
          "decompile_uefi_firmware",
        );
      }

      if (establishedError === undefined && cleanupError !== undefined) {
        throw cleanupError;
      }
    }
  }

  async #decompileFirmware(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    imageSha256: string,
    scan: UefiImageScanSummary,
    signal: AbortSignal,
    checkpoint: () => void,
    remainingTimeMs?: () => number,
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
      remainingTimeMs,
    );
  }

  async #decompileDirectory(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    signal: AbortSignal,
    checkpoint: () => void,
    remainingTimeMs?: () => number,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const MAX_DIRECTORY_INVENTORY_ENTRIES = 10_000;
    const limitations: string[] = [];
    const dirEntries: Array<{
      name: string;
      parentPath: string;
      isFile: () => boolean;
    }> = [];
    const dirQueue: string[] = [input.path];

    while (dirQueue.length > 0) {
      checkpoint();
      signal.throwIfAborted();
      const currentDir = dirQueue.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch (dirErr) {
        if (currentDir === input.path) {
          throw new Error(
            `Selected directory root is not accessible: ${errorMessage(dirErr)}`,
          );
        }
        if (limitations.length < 50) {
          limitations.push(
            `Directory subtree could not be read: ${errorMessage(dirErr)}`,
          );
        }
        continue;
      }
      for (const entry of entries) {
        checkpoint();
        signal.throwIfAborted();
        if (dirEntries.length >= MAX_DIRECTORY_INVENTORY_ENTRIES) {
          limitations.push(
            `Directory discovery stopped after reaching ${MAX_DIRECTORY_INVENTORY_ENTRIES} entry budget.`,
          );
          dirQueue.length = 0;
          break;
        }
        if (entry.isDirectory()) {
          dirQueue.push(join(currentDir, entry.name));
        } else if (entry.isFile()) {
          dirEntries.push({
            name: entry.name,
            parentPath: currentDir,
            isFile: () => true,
          });
        }
      }
    }

    const guidRegex =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
    const embeddedGuidRegex =
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

    const manifestModulesByRelPath = new Map<
      string,
      {
        guid?: string | null | undefined;
        name?: string | undefined;
        phase?: string | undefined;
      }
    >();
    let manifestSha256: string | null = null;
    try {
      const manifestPath = join(input.path, "firmware_manifest.json");
      if (existsSync(manifestPath)) {
        const manifestRaw = await readFile(manifestPath);
        manifestSha256 = sha256Hex(manifestRaw);
        const parsed = JSON.parse(manifestRaw.toString("utf8"));
        if (Array.isArray(parsed?.modules)) {
          for (let mIdx = 0; mIdx < parsed.modules.length; mIdx++) {
            const m = parsed.modules[mIdx];
            if (!m || typeof m !== "object") continue;
            if (typeof m.payload_file !== "string") continue;
            const norm = m.payload_file
              .split(/[/\\]+/)
              .join("/")
              .toLowerCase();

            let validGuid: string | null | undefined = undefined;
            if (m.guid !== undefined && m.guid !== null) {
              if (typeof m.guid === "string" && guidRegex.test(m.guid)) {
                validGuid = m.guid.toLowerCase();
              } else {
                limitations.push(
                  `Manifest module at index ${mIdx} has invalid GUID format; using payload-derived fallback.`,
                );
              }
            } else if (m.guid === null) {
              validGuid = null;
            }

            let validName: string | undefined = undefined;
            if (typeof m.name === "string" && m.name.length > 0) {
              validName = m.name;
            } else if (m.name !== undefined) {
              limitations.push(
                `Manifest module at index ${mIdx} has non-string name; using filename fallback.`,
              );
            }

            let validPhase: string | undefined = undefined;
            if (typeof m.phase === "string") {
              const upperPhase = m.phase.toUpperCase();
              if (
                ["SEC", "PEI", "DXE", "SMM", "APP", "MISC"].includes(upperPhase)
              ) {
                validPhase = upperPhase;
              } else {
                limitations.push(
                  `Manifest module at index ${mIdx} has unrecognized phase "${m.phase}"; using path-derived fallback.`,
                );
              }
            } else if (m.phase !== undefined) {
              limitations.push(
                `Manifest module at index ${mIdx} has non-string phase; using path-derived fallback.`,
              );
            }

            manifestModulesByRelPath.set(norm, {
              guid: validGuid,
              name: validName,
              phase: validPhase,
            });
          }
        }
      }
    } catch (manifestErr) {
      limitations.push(
        `Failed to parse firmware_manifest.json: ${errorMessage(manifestErr)}`,
      );
    }

    interface CandidateModule {
      readonly fullPath: string;
      readonly identityRelPath: string;
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
      } catch (sniffErr: unknown) {
        if (limitations.length < 50) {
          limitations.push(
            `Candidate file ${entry.name} could not be read: ${errorMessage(sniffErr)}`,
          );
        }
        continue;
      }
      if (fileStat.size < 40 || fileStat.size > 32 * 1024 * 1024) continue;

      let isPeOrTe = false;
      let owner: OwnedFileHandle | undefined;
      try {
        const rawHandle = await open(fullPath, "r");
        owner = new OwnedFileHandle(rawHandle);
        const probeLen = Math.min(fileStat.size, 4096);
        const headerBuf = Buffer.alloc(probeLen);
        const { bytesRead } = await owner.handle.read(
          headerBuf,
          0,
          probeLen,
          0,
        );
        if (bytesRead >= 40) {
          if (headerBuf[0] === 0x56 && headerBuf[1] === 0x5a) {
            // Terse Executable ("VZ")
            const reader = new BinaryReader(
              headerBuf,
              true,
              "UEFI candidate TE header",
            );
            const machine = reader.u16(2);
            const numSections = reader.u8(4);
            if (machine !== 0 && numSections > 0) {
              isPeOrTe = true;
            }
          } else if (
            headerBuf[0] === 0x4d &&
            headerBuf[1] === 0x5a &&
            bytesRead >= 64
          ) {
            // Portable Executable ("MZ")
            const reader = new BinaryReader(
              headerBuf,
              true,
              "UEFI candidate PE DOS header",
            );
            const eLfanew = reader.u32(60);
            if (eLfanew >= 64 && eLfanew + 24 <= fileStat.size) {
              let peHeaderBuf: Buffer | undefined;
              if (eLfanew + 24 <= bytesRead) {
                peHeaderBuf = headerBuf.subarray(eLfanew, eLfanew + 24);
              } else {
                const extraBuf = Buffer.alloc(24);
                const { bytesRead: extraRead } = await owner.handle.read(
                  extraBuf,
                  0,
                  24,
                  eLfanew,
                );
                if (extraRead >= 24) {
                  peHeaderBuf = extraBuf;
                }
              }
              if (peHeaderBuf !== undefined) {
                const peReader = new BinaryReader(
                  peHeaderBuf,
                  true,
                  "UEFI candidate PE header",
                );
                const peSig = peReader.u32(0);
                if (peSig === 0x00004550) {
                  const machine = peReader.u16(4);
                  const numSections = peReader.u16(6);
                  if (machine !== 0 && numSections > 0) {
                    isPeOrTe = true;
                  }
                }
              }
            }
          }
        }
      } catch (sniffErr: unknown) {
        if (limitations.length < 50) {
          limitations.push(
            `Candidate file ${entry.name} could not be read: ${errorMessage(sniffErr)}`,
          );
        }
        continue;
      } finally {
        if (owner !== undefined) {
          const released = await this.#resources.release({
            kind: "file-handle",
            resource: fullPath,
            handle: owner,
          });
          if (released.kind === "failed") {
            const cleanupErr = new ProviderCleanupError(
              UEFI_PROVIDER_IDENTITY.id,
              released.lease.cleanupResources ?? [fullPath],
              { reason: errorMessage(released.cause) },
              { cause: released.cause, operation: "decompile_uefi_firmware" },
            );
            new AnalysisCleanupLeaseGroup(cleanupErr, [released.lease]);
            throw cleanupErr;
          }
        }
      }
      if (!isPeOrTe) continue;

      const relPath = relative(input.path, fullPath);
      const identityRelPath =
        HOST_PLATFORM.platform === "win32"
          ? relPath.replaceAll("\\", "/")
          : relPath;
      const manifestLookupKey = relPath
        .split(/[/\\]+/)
        .join("/")
        .toLowerCase();
      const segments = manifestLookupKey.split("/");
      const fromManifest = manifestModulesByRelPath.get(manifestLookupKey);

      let phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC" = "DXE";
      const manifestPhase = fromManifest?.phase?.toUpperCase();
      if (
        manifestPhase &&
        ["SEC", "PEI", "DXE", "SMM", "APP", "MISC"].includes(manifestPhase)
      ) {
        phase = manifestPhase as "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC";
      } else if (segments.some((s) => s === "sec")) {
        phase = "SEC";
      } else if (segments.some((s) => s === "pei" || s === "peim")) {
        phase = "PEI";
      } else if (segments.some((s) => s === "smm")) {
        phase = "SMM";
      } else if (segments.some((s) => s === "app" || s === "application")) {
        phase = "APP";
      } else if (segments.some((s) => s === "misc")) {
        phase = "MISC";
      } else if (segments.some((s) => s === "dxe")) {
        phase = "DXE";
      }

      if (
        input.filter_phase !== "all" &&
        phase.toLowerCase() !== input.filter_phase.toLowerCase()
      ) {
        continue;
      }

      let guid: string | null = null;
      if (fromManifest?.guid) {
        guid = fromManifest.guid.toLowerCase();
      } else {
        const nameMatch = entry.name.match(embeddedGuidRegex);
        if (nameMatch && nameMatch[1]) {
          guid = nameMatch[1].toLowerCase();
        } else {
          const pathMatch = manifestLookupKey.match(embeddedGuidRegex);
          if (pathMatch && pathMatch[1]) {
            guid = pathMatch[1].toLowerCase();
          }
        }
      }

      let rawName = entry.name.replace(/\.(pe|efi|bin|te)$/i, "");
      if (
        typeof fromManifest?.name === "string" &&
        fromManifest.name.length > 0
      ) {
        rawName = fromManifest.name;
      } else if (guid) {
        const parentBase = basename(parent);
        const prefix = `${guid}_`;
        if (parentBase.toLowerCase().startsWith(prefix)) {
          const candidateName = parentBase.slice(prefix.length);
          if (candidateName.length > 0) {
            rawName = candidateName;
          }
        }
      }
      const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

      candidates.push({
        fullPath,
        identityRelPath,
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
      compareUnicodeCodePoints(a.identityRelPath, b.identityRelPath),
    );

    const dirHash = createHash("sha256");
    dirHash.update("manifest:" + (manifestSha256 ?? "none") + "\n");
    const discoveredModules: DiscoveredUefiModule[] = [];

    const MAX_PRELOAD_BYTES = 32 * 1024 * 1024;
    let retainedPreloadBytes = 0;

    for (let i = 0; i < candidates.length; i++) {
      checkpoint();
      signal.throwIfAborted();
      const candidate = candidates[i]!;
      const content = await readFile(candidate.fullPath);
      const fileSha256 = sha256Hex(content);
      dirHash.update(
        compositeKey([candidate.identityRelPath, fileSha256]) + "\n",
      );

      const isSelected = i < request.input.max_modules;
      let retainedBytes: Buffer | undefined;
      if (
        isSelected &&
        retainedPreloadBytes + content.byteLength <= MAX_PRELOAD_BYTES
      ) {
        retainedBytes = content;
        retainedPreloadBytes += content.byteLength;
      }

      discoveredModules.push({
        guid: candidate.guid,
        rawName: candidate.rawName,
        cleanName: candidate.cleanName,
        phase: candidate.phase,
        ...(retainedBytes !== undefined ? { bytes: retainedBytes } : {}),
        sourcePath: candidate.fullPath,
        byteLength: candidate.size,
      });
    }

    const dirSha256 =
      candidates.length === 0 && manifestSha256 === null
        ? sha256Hex(Buffer.alloc(0))
        : dirHash.digest("hex");

    return this.#stageAndPublishModules(
      request,
      dirSha256,
      discoveredModules,
      limitations,
      signal,
      checkpoint,
      "directory",
      remainingTimeMs,
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
