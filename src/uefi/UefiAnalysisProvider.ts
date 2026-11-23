import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import { decodePeMachine, peOptionalHeaderMagic } from "../domain/peMachine.js";
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
  opendir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buffer } from "node:stream/consumers";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { isAbortOf } from "../process/SignalAbort.js";
import { isPathWithinRoot } from "../domain/localPath.js";
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
  SafeOutputTree,
  outputDirectoryAdmissionRefusal,
  SafeOutputTreeDestinationRefusal,
  DirectoryArtifactReader,
  type DirectoryArtifactEntry,
  DirectoryArtifactRootFailure,
  DirectoryArtifactTraversalLimit,
  ArtifactFileCleanupFailure,
} from "../resources/index.js";
import {
  inspectGhidraInstallation,
  ghidraJavaEnvironment,
  type GhidraInstallationHost,
  type GhidraInstallationOptions,
} from "../ghidra/GhidraInstallation.js";
import {
  ghidraKnownProviderDefectLimitations,
  unverifiedGhidraBuildLimitation,
} from "../ghidra/GhidraReleasePolicy.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
  type ProviderAvailability,
  type RetainedResourceScope,
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
  ownedCommandResources,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import type { HostPlatform } from "../platform/HostPlatform.js";
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
  readonly sourceRelPath?: string | undefined;
  readonly sourceLogicalPath?: string | undefined;
  readonly sourceStream?: string | null | undefined;
  readonly sourceRange?:
    | { readonly offset: number; readonly length: number }
    | null
    | undefined;
  readonly expectedSha256?: string | undefined;
  readonly byteLength: number;
  readonly entry?: DirectoryArtifactEntry | undefined;
}

interface UefiEntryPointScaffolding {
  readonly typedefs: readonly string[];
  readonly prototype: string;
  readonly functionDefinition: string;
}

export type UefiMachineWidth = "32" | "64" | "unknown";

export const sanitizeCComment = (text: string): string =>
  text
    .replace(/\0/g, " ")
    .replace(/\*\//g, "* /")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim();

export const detectPeTeMachineWidth = (bytes: Buffer): UefiMachineWidth => {
  if (bytes.length < 4) {
    return "unknown";
  }

  try {
    const reader = new BinaryReader(bytes, true, "UEFI image header");
    let candidateMachine: number | undefined;
    let isPe = false;
    let optionalHeaderMagic: number | undefined;

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
          isPe = true;
          candidateMachine = reader.u16(eLfanew + 4);
          if (eLfanew + 26 <= bytes.length) {
            const sizeOfOpt = reader.u16(eLfanew + 20);
            if (sizeOfOpt >= 2) {
              optionalHeaderMagic = reader.u16(eLfanew + 24);
            }
          }
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
      isPe = true;
      candidateMachine = reader.u16(4);
      if (bytes.length >= 26) {
        const sizeOfOpt = reader.u16(20);
        if (sizeOfOpt >= 2) {
          optionalHeaderMagic = reader.u16(24);
        }
      }
    }

    if (candidateMachine !== undefined) {
      if (isPe) {
        if (
          optionalHeaderMagic === undefined ||
          (optionalHeaderMagic !== 0x10b && optionalHeaderMagic !== 0x20b)
        ) {
          return "unknown";
        }
      }

      const decoded = decodePeMachine(candidateMachine);
      if (decoded !== undefined && !decoded.nativeOsOverride) {
        if (isPe) {
          const expectedMagic = peOptionalHeaderMagic(decoded.architecture);
          if (optionalHeaderMagic !== expectedMagic) {
            return "unknown";
          }
        }
        return decoded.architecture === "x86_64" ||
          decoded.architecture === "arm64"
          ? "64"
          : "32";
      }
      if (candidateMachine === 0x5032 || candidateMachine === 0x6232) {
        if (isPe && optionalHeaderMagic !== 0x10b) {
          return "unknown";
        }
        return "32";
      }
      if (candidateMachine === 0x5064 || candidateMachine === 0x6264) {
        if (isPe && optionalHeaderMagic !== 0x20b) {
          return "unknown";
        }
        return "64";
      }
      return "unknown";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
};

export const phaseFromFfsTypeName = (
  typeName?: string,
): "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC" | undefined => {
  if (!typeName) return undefined;
  const norm = typeName.toLowerCase().trim();
  if (norm === "security-core") return "SEC";
  if (norm.includes("pei")) return "PEI";
  if (norm.includes("smm") || norm.includes("mm-")) return "SMM";
  if (norm === "application") return "APP";
  if (norm === "driver" || norm === "dxe-core") return "DXE";
  return undefined;
};

export const isPhaseSupportedByFfsType = (
  phase: string,
  typeName?: string,
): boolean => {
  if (!typeName) return true;
  const upperPhase = phase.toUpperCase();
  const norm = typeName.toLowerCase().trim();
  if (norm === "combined-peim-driver") {
    return upperPhase === "PEI" || upperPhase === "DXE";
  }
  if (norm === "combined-smm-dxe") {
    return upperPhase === "SMM" || upperPhase === "DXE";
  }
  if (norm === "security-core") return upperPhase === "SEC";
  if (norm === "pei-core" || norm === "peim") return upperPhase === "PEI";
  if (norm === "driver" || norm === "dxe-core") return upperPhase === "DXE";
  if (
    norm === "smm" ||
    norm === "smm-core" ||
    norm === "mm-standalone" ||
    norm === "mm-core-standalone"
  ) {
    return upperPhase === "SMM";
  }
  if (norm === "application") return upperPhase === "APP";
  return true;
};

export const buildUefiEntryPointScaffolding = (
  identifier: string,
  rawName: string,
  byteLength: number,
  phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC",
  typeName?: string,
  machineWidth: UefiMachineWidth = "64",
): UefiEntryPointScaffolding => {
  const boundedRawName = ellipsisExcerpt(rawName, 256);
  const safeName = sanitizeCComment(boundedRawName);
  const boundedTypeName =
    typeName !== undefined ? ellipsisExcerpt(typeName, 64) : undefined;
  const safeTypeName =
    boundedTypeName !== undefined
      ? sanitizeCComment(boundedTypeName)
      : undefined;
  const statusType =
    machineWidth === "32"
      ? "uint32_t"
      : machineWidth === "64"
        ? "uint64_t"
        : "UINTN";
  const statusTypedefs =
    machineWidth === "unknown"
      ? ["typedef uintptr_t UINTN;", "typedef UINTN EFI_STATUS;"]
      : [`typedef ${statusType} EFI_STATUS;`];
  const normType = typeName?.toLowerCase().trim();
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

  if (
    normType === "peim" ||
    (normType === "combined-peim-driver" && phase === "PEI") ||
    phase === "PEI"
  ) {
    return {
      typedefs: [
        ...statusTypedefs,
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

  if (normType === "security-core" || phase === "SEC") {
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

  if (normType === "mm-standalone") {
    return {
      typedefs: [
        ...statusTypedefs,
        "typedef void* EFI_HANDLE;",
        "struct _EFI_MM_SYSTEM_TABLE;",
        "typedef struct _EFI_MM_SYSTEM_TABLE EFI_MM_SYSTEM_TABLE;",
        "#define EFI_SUCCESS 0",
      ],
      prototype: `EFI_STATUS EFIAPI ${identifier}EntryPoint(EFI_HANDLE ImageHandle, EFI_MM_SYSTEM_TABLE *MmSystemTable);`,
      functionDefinition: [
        `EFI_STATUS EFIAPI ${identifier}EntryPoint(`,
        "    EFI_HANDLE ImageHandle,",
        "    EFI_MM_SYSTEM_TABLE *MmSystemTable",
        ") {",
        `    // Reconstructed Standalone MM EntryPoint scaffolding for ${safeName}`,
        `    // Size: ${byteLength} bytes`,
        "    EFI_STATUS Status = EFI_SUCCESS;",
        "    (void)ImageHandle;",
        "    (void)MmSystemTable;",
        "    return Status;",
        "}",
      ].join("\n"),
    };
  }

  if (normType === "mm-core-standalone") {
    return {
      typedefs: [
        ...statusTypedefs,
        "struct _EFI_MM_STARTUP_DESCRIPTOR;",
        "typedef struct _EFI_MM_STARTUP_DESCRIPTOR EFI_MM_STARTUP_DESCRIPTOR;",
        "#define EFI_SUCCESS 0",
      ],
      prototype: `EFI_STATUS EFIAPI ${identifier}EntryPoint(const EFI_MM_STARTUP_DESCRIPTOR *MmStartupDescriptor);`,
      functionDefinition: [
        `EFI_STATUS EFIAPI ${identifier}EntryPoint(`,
        "    const EFI_MM_STARTUP_DESCRIPTOR *MmStartupDescriptor",
        ") {",
        `    // Reconstructed Standalone MM Core EntryPoint scaffolding for ${safeName}`,
        `    // Size: ${byteLength} bytes`,
        "    EFI_STATUS Status = EFI_SUCCESS;",
        "    (void)MmStartupDescriptor;",
        "    return Status;",
        "}",
      ].join("\n"),
    };
  }

  if (normType === "smm-core") {
    return {
      typedefs: [],
      prototype: `void EFIAPI ${identifier}EntryPoint(void *SmramDescriptor);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        "    void *SmramDescriptor",
        ") {",
        `    // Reconstructed SMM Core EntryPoint scaffolding for ${safeName}`,
        `    // Size: ${byteLength} bytes`,
        "    (void)SmramDescriptor;",
        "}",
      ].join("\n"),
    };
  }

  const isSupportedDxeEntryType =
    normType === "driver" ||
    normType === "application" ||
    normType === "combined-smm-dxe" ||
    normType === "combined-peim-driver";

  if (
    (phase === "MISC" || !["DXE", "APP", "SMM"].includes(phase)) &&
    !isSupportedDxeEntryType
  ) {
    return {
      typedefs: [],
      prototype: `void EFIAPI ${identifier}EntryPoint(void);`,
      functionDefinition: [
        `void EFIAPI ${identifier}EntryPoint(`,
        ") {",
        `    // Reconstructed EntryPoint scaffolding for unclassified payload ${safeName}`,
        `    // Unknown ABI: unclassified module with no supported entry ABI${safeTypeName ? ` (type: ${safeTypeName})` : ""}`,
        `    // Size: ${byteLength} bytes`,
        "}",
      ].join("\n"),
    };
  }

  return {
    typedefs: [
      ...statusTypedefs,
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

const formatMarkdownCodeSpan = (text: string): string => {
  const sanitized = text
    .replace(/\0/g, " ")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/[\r\n]+/g, " ");
  const matches = sanitized.match(/`+/g);
  let maxBackticks = 0;
  if (matches) {
    for (const m of matches) {
      if (m.length > maxBackticks) maxBackticks = m.length;
    }
  }
  const delimiter = "`".repeat(maxBackticks + 1);
  const needsPadding = sanitized.startsWith("`") || sanitized.endsWith("`");
  const content = needsPadding ? ` ${sanitized} ` : sanitized;
  return `${delimiter}${content}${delimiter}`;
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
export interface UefiProviderOptions {
  readonly workerModulePath?: string;
  readonly ghidraInstallationHost?: GhidraInstallationHost;
  readonly hostPlatform?: HostPlatform;
}

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
  readonly #ghidraInstallationHost?: GhidraInstallationHost | undefined;
  readonly #hostPlatform: HostPlatform;
  readonly #inspectionOwner: RetainedResourceScope = {
    retain: (owner, resource) =>
      this.#resources.retain({
        kind: "lease",
        resource,
        lease: { release: () => owner.close() },
      }),
    run: (operation) => this.#resources.run(operation),
  };

  constructor(workerModulePathOrOptions?: string | UefiProviderOptions) {
    if (typeof workerModulePathOrOptions === "string") {
      this.#workerModulePath = workerModulePathOrOptions;
      this.#hostPlatform = HOST_PLATFORM;
    } else {
      this.#workerModulePath =
        workerModulePathOrOptions?.workerModulePath ??
        fileURLToPath(new URL("./UefiLzmaWorker.js", import.meta.url));
      this.#ghidraInstallationHost =
        workerModulePathOrOptions?.ghidraInstallationHost;
      this.#hostPlatform =
        workerModulePathOrOptions?.hostPlatform ?? HOST_PLATFORM;
    }
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
    const onParentAbort = () => {
      controller.abort(
        cancelledBy(request.operation, carriedReason(parent?.reason)),
      );
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
      if (request.operation === "decompile_uefi_firmware") {
        await SafeOutputTree.checkDestination(
          request.input.output_directory,
        ).catch((cause: unknown) => {
          throw outputDirectoryAdmissionRefusal(
            request.operation,
            "output_directory",
            cause,
          );
        });
      }
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
    reader?: DirectoryArtifactReader | undefined,
    coverage: "complete" | "partial" = "complete",
    sourceCoverage?: "complete" | "partial" | "unknown" | undefined,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const modulesToProcess = discoveredModules.slice(0, input.max_modules);

    let isCoveragePartial =
      coverage === "partial" || discoveredModules.length > input.max_modules;
    const effectiveLimitations = [...limitations];
    if (discoveredModules.length > input.max_modules) {
      effectiveLimitations.push(
        `Decompilation capped at ${input.max_modules} of ${discoveredModules.length} discovered modules.`,
      );
    }

    await SafeOutputTree.checkDestination(input.output_directory).catch(
      (cause: unknown) => {
        throw outputDirectoryAdmissionRefusal(
          request.operation,
          "output_directory",
          cause,
        );
      },
    );

    const ghidraInstallDir = process.env.GHIDRA_INSTALL_DIR;
    const ghidraJavaHome = process.env.JAVA_HOME;
    const ghidraOptions: GhidraInstallationOptions = {
      signal,
      resourceOwner: this.#inspectionOwner,
      environment: process.env,
      ...(ghidraInstallDir ? { installDir: ghidraInstallDir } : {}),
      ...(ghidraJavaHome ? { javaHome: ghidraJavaHome } : {}),
    };
    const ghidraInspection = await (this.#ghidraInstallationHost === undefined
      ? inspectGhidraInstallation(ghidraOptions)
      : inspectGhidraInstallation(ghidraOptions, this.#ghidraInstallationHost));
    const ghidraBin =
      ghidraInspection?.status === "available"
        ? ghidraInspection.analyzeHeadlessPath
        : null;
    const ghidraVersion =
      ghidraInspection?.status === "available"
        ? ghidraInspection.providerVersion
        : null;
    let ghidraEngineUsed = false;

    if (
      ghidraInspection?.status === "unavailable" &&
      (Boolean(process.env.GHIDRA_INSTALL_DIR) ||
        ghidraInspection.installDir !== null)
    ) {
      const sourceLabel = process.env.GHIDRA_INSTALL_DIR
        ? "Configured Ghidra installation"
        : "Discovered Ghidra installation";
      effectiveLimitations.push(
        `${sourceLabel} is unavailable: ${ghidraInspection.rejection.reason}`,
      );
    }

    const tempRoot = await PrivateRuntimeRoot.create({
      prefix: "rea-uefi-decompile-",
    });

    const MAX_DISASSEMBLY_MODULE_BYTES = 2 * 1024 * 1024;
    const MAX_DISASSEMBLY_TOTAL_BYTES = 64 * 1024 * 1024;
    const MAX_DISASSEMBLY_FAILURE_DIAGNOSTICS = 20;
    let recordedDisassemblyFailures = 0;
    let totalStagedAsmBytes = 0;
    const usedDisassemblers = new Set<string>();

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

    const formatDecompileBudgetLimit = (
      moduleName: string,
      limitBytes: number,
    ): string => {
      const limitLabel =
        limitBytes < MAX_DECOMPILE_MODULE_BYTES
          ? "64 MiB aggregate staging budget"
          : "4 MiB per-module limit";
      return `Decompiled C output for ${moduleName} stopped after reaching ${limitLabel}; recovered with reconstructed entry scaffolding.`;
    };

    const MAX_RAW_PAYLOAD_TOTAL_BYTES = 128 * 1024 * 1024;
    let totalStagedRawBytes = 0;

    let publishedResult: UefiDecompileResult | undefined;
    let establishedError: unknown;

    try {
      let pendingGhidraCleanupFailure: ProviderCleanupError | undefined;
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
        type?: string | undefined;
        source_path?: string | undefined;
        source_logical_path?: string | undefined;
        source_stream?: string | null | undefined;
        source_range?: { offset: number; length: number } | null | undefined;
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
        asm_generator: string | null;
        code_bytes: number;
      }> = [];
      const publicationEntries: UefiPublicationEntry[] = [];

      const isMultiModuleBatch = modulesToProcess.length > 1;
      const ghidraBatchInputDir = join(tempRoot.path, "ghidra_batch_in");
      const ghidraBatchOutputDir = join(tempRoot.path, "ghidra_batch_out");
      const ghidraBatchOutcomeMap = new Map<
        number,
        { cPath: string; outcomePath: string }
      >();
      const successfullyStagedInputs = new Set<number>();

      let ghidraBatchFailed = false;
      if (
        ghidraBin !== null &&
        pendingGhidraCleanupFailure === undefined &&
        modulesToProcess.length > 0
      ) {
        const PUBLICATION_RESERVE_MS = 5_000;
        const GHIDRA_SHUTDOWN_GRACE_MS = 5_000;
        const timeLeftForGhidra =
          remainingTimeMs !== undefined
            ? Math.floor(
                remainingTimeMs() -
                  PUBLICATION_RESERVE_MS -
                  GHIDRA_SHUTDOWN_GRACE_MS,
              )
            : 45_000;

        if (timeLeftForGhidra <= 1_000) {
          isCoveragePartial = true;
          effectiveLimitations.push(
            "Ghidra C decompilation omitted to preserve deadline for publication; generated entry point scaffolding instead.",
          );
        } else {
          const ghidraTimeout = Math.floor(
            Math.min(45_000, Math.max(1_000, timeLeftForGhidra)),
          );
          const ghidraRunId = `rea-ghidra-decomp-${randomUUID()}`;
          let ghidraCleanupRetained = false;
          const retainGhidraCleanup = (owner: ProviderProcessSupervisor) => {
            if (ghidraCleanupRetained) return;
            ghidraCleanupRetained = true;
            const ownership = owner.launch.ownership;
            const leaseResources =
              ownership === undefined
                ? [tempRoot.path]
                : ownedCommandResources(ownership, tempRoot.path);
            const cleanupLease = new AnalysisCleanupLease(async () => {
              const stopped = await owner.stop();
              if (stopped.status === "incomplete") {
                throw new Error(stopped.reason);
              }
            }, leaseResources);
            this.#resources.retain({
              kind: "lease",
              resource:
                ownership === undefined
                  ? `ghidra-process-${ghidraRunId}`
                  : `ghidra-process-${ownership.runId}`,
              lease: cleanupLease,
            });
            pendingGhidraCleanupFailure = new ProviderCleanupError(
              UEFI_PROVIDER_IDENTITY.id,
              leaseResources,
              { reason: "Ghidra process termination failed on Windows" },
              { operation: "decompile_uefi_firmware" },
            );
            new AnalysisCleanupLeaseGroup(pendingGhidraCleanupFailure, [
              cleanupLease,
            ]);
          };

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
            const baseJavaEnv = ghidraJavaEnvironment(
              ghidraInspection?.javaHome ?? undefined,
              process.env,
              this.#hostPlatform.platform,
            );
            const ghidraEnv: NodeJS.ProcessEnv = {
              ...baseJavaEnv,
              JDK_JAVA_OPTIONS: `-Duser.home="${ghidraHome}" -Djava.io.tmpdir="${ghidraTemp}"`,
              HOME: ghidraHome,
              TMPDIR: ghidraTemp,
              XDG_CONFIG_HOME: ghidraConfig,
              XDG_CACHE_HOME: ghidraTemp,
              XDG_DATA_HOME: ghidraHome,
              ...(this.#hostPlatform.platform === "win32"
                ? {
                    USERPROFILE: ghidraHome,
                    APPDATA: ghidraConfig,
                    LOCALAPPDATA: ghidraTemp,
                    TEMP: ghidraTemp,
                    TMP: ghidraTemp,
                  }
                : {}),
            };

            let ghidraArgs: string[];
            if (!isMultiModuleBatch) {
              const singleEfiPath = join(tempRoot.path, "mod_1.efi");
              const singleOutC = join(tempRoot.path, "mod_1_decompiled.c");
              const m = modulesToProcess[0]!;
              let b = m.bytes;
              if (b === undefined && (m.entry || m.sourcePath)) {
                if (reader !== undefined && m.entry !== undefined) {
                  b = await buffer(await reader.open(m.entry, signal));
                } else if (m.sourcePath) {
                  b = await readFile(m.sourcePath);
                }
                const freshSha256 = sha256Hex(b ?? Buffer.alloc(0));
                if (
                  m.expectedSha256 !== undefined &&
                  freshSha256 !== m.expectedSha256
                ) {
                  throw new Error(
                    `Source module ${m.sourceRelPath ?? m.sourcePath} was modified concurrently during analysis (expected sha256 ${m.expectedSha256}, observed ${freshSha256}).`,
                  );
                }
              }
              await writeFile(singleEfiPath, b ?? Buffer.alloc(0));
              successfullyStagedInputs.add(1);
              ghidraArgs = [
                tempRoot.path,
                "UefiDecomp_1",
                "-import",
                singleEfiPath,
                "-scriptPath",
                bridgeDir,
                "-postScript",
                scriptPath,
                singleOutC,
                String(MAX_DECOMPILE_MODULE_BYTES),
                String(MAX_DECOMPILE_TOTAL_BYTES),
                "-deleteProject",
              ];
              ghidraBatchOutcomeMap.set(1, {
                cPath: singleOutC,
                outcomePath: `${singleOutC}.outcome.json`,
              });
            } else {
              await Promise.all([
                mkdir(ghidraBatchInputDir, { recursive: true }),
                mkdir(ghidraBatchOutputDir, { recursive: true }),
              ]);
              let totalBatchStagedInputBytes = 0;
              for (let i = 0; i < modulesToProcess.length; i++) {
                const seq = i + 1;
                const m = modulesToProcess[i]!;
                let b = m.bytes;
                if (b === undefined && (m.entry || m.sourcePath)) {
                  if (reader !== undefined && m.entry !== undefined) {
                    b = await buffer(await reader.open(m.entry, signal));
                  } else if (m.sourcePath) {
                    b = await readFile(m.sourcePath);
                  }
                  const freshSha256 = sha256Hex(b ?? Buffer.alloc(0));
                  if (
                    m.expectedSha256 !== undefined &&
                    freshSha256 !== m.expectedSha256
                  ) {
                    throw new Error(
                      `Source module ${m.sourceRelPath ?? m.sourcePath} was modified concurrently during analysis (expected sha256 ${m.expectedSha256}, observed ${freshSha256}).`,
                    );
                  }
                }
                const contentBytes = b ?? Buffer.alloc(0);
                if (
                  totalBatchStagedInputBytes + contentBytes.length >
                  MAX_RAW_PAYLOAD_TOTAL_BYTES
                ) {
                  isCoveragePartial = true;
                  if (
                    !effectiveLimitations.includes(
                      "Batch decompilation input staging truncated after reaching 128 MiB aggregate staging budget.",
                    )
                  ) {
                    effectiveLimitations.push(
                      "Batch decompilation input staging truncated after reaching 128 MiB aggregate staging budget.",
                    );
                  }
                  continue;
                }
                totalBatchStagedInputBytes += contentBytes.length;
                const efiFile = join(ghidraBatchInputDir, `mod_${seq}.efi`);
                await writeFile(efiFile, contentBytes);
                successfullyStagedInputs.add(seq);
                const outC = join(ghidraBatchOutputDir, `mod_${seq}.efi.c`);
                ghidraBatchOutcomeMap.set(seq, {
                  cPath: outC,
                  outcomePath: `${outC}.outcome.json`,
                });
              }
              ghidraArgs = [
                tempRoot.path,
                "UefiDecompBatch",
                "-import",
                ghidraBatchInputDir,
                "-scriptPath",
                bridgeDir,
                "-postScript",
                scriptPath,
                ghidraBatchOutputDir,
                String(MAX_DECOMPILE_MODULE_BYTES),
                String(MAX_DECOMPILE_TOTAL_BYTES),
                "-deleteProject",
              ];
            }

            let execCmd = ghidraBin;
            let execArgs = ghidraArgs;
            if (
              this.#hostPlatform.platform === "win32" &&
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
            if (this.#hostPlatform.platform === "win32") {
              await runOwnedCommand(
                {
                  command: execCmd,
                  arguments: execArgs,
                  runId: ghidraRunId,
                  windowsVerbatimArguments: true,
                  platform: "win32",
                  env: ghidraEnv,
                  hostEnvironment: process.env,
                  signal,
                },
                {
                  timeoutMs: ghidraTimeout,
                  diagnosticBytes: 10 * 1024 * 1024,
                },
                {
                  signal,
                  retainCleanup: (owner) => retainGhidraCleanup(owner),
                },
              );
            } else {
              await execFileOutput(execCmd, execArgs, {
                signal,
                stopSignal: "SIGTERM",
                timeout: ghidraTimeout,
                maxBuffer: 10 * 1024 * 1024,
                env: ghidraEnv,
              });
            }
          } catch (ghidraBatchError: unknown) {
            if (signal.aborted) signal.throwIfAborted();
            if (isAbortOf(ghidraBatchError, signal)) throw ghidraBatchError;
            ghidraBatchFailed = true;
            if (
              ghidraBatchError instanceof OwnedCommandFailure &&
              ghidraBatchError.cleanupOwner !== undefined
            ) {
              retainGhidraCleanup(ghidraBatchError.cleanupOwner);
            }
            if (pendingGhidraCleanupFailure !== undefined) {
              throw pendingGhidraCleanupFailure;
            }
            let rawErrMsg = errorMessage(ghidraBatchError);
            if (ghidraBatchError instanceof OwnedCommandFailure) {
              const diag =
                ghidraBatchError.snapshot?.stderr.text?.trim() ||
                ghidraBatchError.snapshot?.stdout.text?.trim();
              if (diag) {
                rawErrMsg = diag;
              } else if (
                ghidraBatchError.snapshot?.exitCode !== undefined &&
                ghidraBatchError.snapshot?.exitCode !== null
              ) {
                rawErrMsg = `${ghidraBatchError.message} (exit code ${ghidraBatchError.snapshot.exitCode})`;
              }
            }
            const budgetMatch =
              /decompiled C output exceeded (\d+) byte limit/i.exec(rawErrMsg);
            const errDetail = sanitizeDiag(rawErrMsg);
            if (budgetMatch) {
              isCoveragePartial = true;
              const limitBytes = Number(budgetMatch[1]);
              const limitMsg = formatDecompileBudgetLimit(
                !isMultiModuleBatch
                  ? formatMarkdownCodeSpan(
                      ellipsisExcerpt(
                        modulesToProcess[0]!.rawName.replace(/[\r\n]+/g, " "),
                        128,
                      ),
                    )
                  : "one or more modules",
                limitBytes,
              );
              if (!effectiveLimitations.includes(limitMsg)) {
                effectiveLimitations.push(limitMsg);
              }
            } else {
              isCoveragePartial = true;
              if (recordedGhidraFailures < MAX_GHIDRA_FAILURE_DIAGNOSTICS) {
                const targetName = !isMultiModuleBatch
                  ? formatMarkdownCodeSpan(
                      ellipsisExcerpt(
                        modulesToProcess[0]!.rawName.replace(/[\r\n]+/g, " "),
                        128,
                      ),
                    )
                  : "module batch";
                effectiveLimitations.push(
                  `Ghidra C decompilation for ${targetName} failed: ${errDetail}`,
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
      }

      for (const mod of modulesToProcess) {
        if (pendingGhidraCleanupFailure !== undefined) {
          throw pendingGhidraCleanupFailure;
        }
        checkpoint();
        signal.throwIfAborted();

        // Reserve time to finalize completed modules and publish them before the deadline
        const PUBLICATION_RESERVE_MS = 5_000;
        if (remainingTimeMs !== undefined && stagedModules.length > 0) {
          const timeLeft = remainingTimeMs();
          if (timeLeft <= PUBLICATION_RESERVE_MS) {
            isCoveragePartial = true;
            effectiveLimitations.push(
              `Decompilation halted early to finalize and publish ${stagedModules.length} completed modules before operation deadline.`,
            );
            break;
          }
        }

        moduleSeq++;
        let modBytes = mod.bytes;
        let stagedInputDigestMismatched = false;
        if (successfullyStagedInputs.has(moduleSeq)) {
          const stagedEfi = isMultiModuleBatch
            ? join(ghidraBatchInputDir, `mod_${moduleSeq}.efi`)
            : join(tempRoot.path, "mod_1.efi");
          if (existsSync(stagedEfi)) {
            const candidateBytes = await readFile(stagedEfi);
            const candidateSha = sha256Hex(candidateBytes);
            if (
              mod.expectedSha256 !== undefined &&
              candidateSha !== mod.expectedSha256
            ) {
              stagedInputDigestMismatched = true;
              ghidraBatchOutcomeMap.delete(moduleSeq);
              isCoveragePartial = true;
            } else if (modBytes === undefined) {
              modBytes = candidateBytes;
            }
          }
        }
        if (modBytes === undefined && (mod.entry || mod.sourcePath)) {
          let freshBytes: Buffer;
          if (reader !== undefined && mod.entry !== undefined) {
            freshBytes = await buffer(await reader.open(mod.entry, signal));
          } else {
            freshBytes = await readFile(mod.sourcePath!);
          }
          const freshSha256 = sha256Hex(freshBytes);
          if (
            mod.expectedSha256 !== undefined &&
            freshSha256 !== mod.expectedSha256
          ) {
            throw new Error(
              `Source module ${mod.sourceRelPath ?? mod.sourcePath} was modified concurrently during analysis (expected sha256 ${mod.expectedSha256}, observed ${freshSha256}).`,
            );
          }
          modBytes = freshBytes;
        }
        if (modBytes === undefined) {
          modBytes = Buffer.alloc(0);
        }

        const phaseKey = mod.phase.toLowerCase() as keyof typeof phaseCounts;
        if (phaseCounts[phaseKey] !== undefined) {
          phaseCounts[phaseKey]++;
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

        let cIdentifier = boundedName.replace(/[^a-zA-Z0-9_]/g, "_");
        if (/^[0-9]/.test(cIdentifier)) {
          cIdentifier = `_${cIdentifier}`;
        }
        if (cIdentifier.length === 0) {
          cIdentifier = "_Module";
        }
        let moduleRelDir = `${mod.phase}/${idPrefix}_${boundedName}`;
        let occurrence = 0;
        while (allocatedRelDirs.has(moduleRelDir.toLowerCase())) {
          occurrence++;
          moduleRelDir = `${mod.phase}/${idPrefix}_${boundedName}_${occurrence}`;
        }
        allocatedRelDirs.add(moduleRelDir.toLowerCase());

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
          isCoveragePartial = true;
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

        const safeRawName = sanitizeCComment(ellipsisExcerpt(mod.rawName, 256));
        const safeTypeName = mod.typeName
          ? sanitizeCComment(ellipsisExcerpt(mod.typeName, 256))
          : null;
        const safeGuid = mod.guid
          ? sanitizeCComment(ellipsisExcerpt(mod.guid, 256))
          : null;
        const safeLimitationModName = formatMarkdownCodeSpan(
          ellipsisExcerpt(mod.rawName.replace(/[\r\n]+/g, " "), 128),
        );

        if (stagedInputDigestMismatched) {
          const mismatchLimitation = `Decompiled C output for ${safeLimitationModName} discarded due to scratch input digest mismatch; recovered with reconstructed entry scaffolding.`;
          if (!effectiveLimitations.includes(mismatchLimitation)) {
            effectiveLimitations.push(mismatchLimitation);
          }
        }

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
        let headerSha256: string = "";

        let asmRelPath: string | null = null;
        let asmSha256: string | null = null;
        let asmGenerator: string | null = null;
        let disassemblyStatus: "ok" | "failed" | "omitted" = "omitted";
        const scratchBasename = `mod_${moduleSeq}.efi`;
        const tempEfiPath = join(tempRoot.path, scratchBasename);
        let ghidraOutC: string | undefined;
        let outcomeFile: string | undefined;

        await writeFile(tempEfiPath, modBytes);
        try {
          if (input.include_disassembly) {
            const remainingAsmBytes =
              MAX_DISASSEMBLY_TOTAL_BYTES - totalStagedAsmBytes;
            if (remainingAsmBytes <= 0) {
              disassemblyStatus = "omitted";
              isCoveragePartial = true;
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
              const DISASSEMBLER_SHUTDOWN_GRACE_MS = 5_000;
              const timeLeftForDisasm =
                remainingTimeMs !== undefined
                  ? Math.floor(
                      remainingTimeMs() -
                        PUBLICATION_RESERVE_MS -
                        DISASSEMBLER_SHUTDOWN_GRACE_MS,
                    )
                  : 15_000;
              if (timeLeftForDisasm <= 0) {
                disassemblyStatus = "omitted";
                isCoveragePartial = true;
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
                    ["-d", "--no-show-raw-insn", scratchBasename],
                    {
                      cwd: tempRoot.path,
                      signal,
                      stopSignal: "SIGTERM",
                      timeout: disasmTimeout,
                      maxBuffer: maxAsmBuffer,
                    },
                  );
                  asmOutput = stdout;
                  asmGenerator = "llvm-objdump";
                  usedDisassemblers.add("llvm-objdump");
                } catch (err: unknown) {
                  if (signal.aborted) signal.throwIfAborted();
                  if (isAbortOf(err, signal)) throw err;
                  llvmError = err;
                  llvmErrorMsg = errorMessage(err);
                  const remainingForObjdump =
                    remainingTimeMs !== undefined
                      ? Math.floor(
                          remainingTimeMs() -
                            PUBLICATION_RESERVE_MS -
                            DISASSEMBLER_SHUTDOWN_GRACE_MS,
                        )
                      : 15_000;
                  if (remainingForObjdump > 0) {
                    const objdumpTimeout = Math.floor(
                      Math.min(15_000, Math.max(500, remainingForObjdump)),
                    );
                    const configuredCommand =
                      process.env.REA_OBJDUMP_COMMAND ?? "objdump";
                    const objdumpExecutable =
                      configuredCommand.includes("/") ||
                      configuredCommand.includes("\\")
                        ? resolve(process.cwd(), configuredCommand)
                        : configuredCommand;
                    try {
                      const { stdout } = await execFileOutput(
                        objdumpExecutable,
                        ["-d", scratchBasename],
                        {
                          cwd: tempRoot.path,
                          signal,
                          stopSignal: "SIGTERM",
                          timeout: objdumpTimeout,
                          maxBuffer: maxAsmBuffer,
                          env: { ...process.env, DEBUGINFOD_URLS: "" },
                        },
                      );
                      asmOutput = stdout;
                      asmGenerator = configuredCommand;
                      usedDisassemblers.add(configuredCommand);
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
                    isCoveragePartial = true;
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
                    isCoveragePartial = true;
                    if (maxAsmBuffer < remainingAsmBytes) {
                      const perModLimit = `Disassembly output for ${safeLimitationModName} exceeded 2 MiB module budget; omitted disassembly.`;
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
                    isCoveragePartial = true;
                    if (
                      recordedDisassemblyFailures <
                      MAX_DISASSEMBLY_FAILURE_DIAGNOSTICS
                    ) {
                      effectiveLimitations.push(
                        `Disassembly for ${safeLimitationModName} failed: llvm-objdump (${sanitizeDiag(llvmErrorMsg)}), objdump (${sanitizeDiag(objdumpErrorMsg)})`,
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

          const ghidraTarget = ghidraBatchOutcomeMap.get(moduleSeq);
          ghidraOutC = ghidraTarget?.cPath;
          outcomeFile = ghidraTarget?.outcomePath;

          if (ghidraTarget !== undefined) {
            let exporterOutcome: {
              status?: string;
              decompiled_functions?: number;
              failed_functions?: number;
              bytes_written?: number;
              max_output_bytes?: number;
              error?: string;
            } | null = null;
            if (outcomeFile && existsSync(outcomeFile)) {
              try {
                const rawOutcome = await readFile(outcomeFile, "utf8");
                exporterOutcome = JSON.parse(rawOutcome);
              } catch {
                // Ignore unparseable outcome metadata
              }
            }

            if (exporterOutcome?.status === "limit_exceeded") {
              isCoveragePartial = true;
              const effectiveLimitBytes =
                exporterOutcome.max_output_bytes ?? MAX_DECOMPILE_MODULE_BYTES;
              const perModuleLimit = formatDecompileBudgetLimit(
                safeLimitationModName,
                effectiveLimitBytes,
              );
              if (!effectiveLimitations.includes(perModuleLimit)) {
                effectiveLimitations.push(perModuleLimit);
              }
              if (ghidraOutC && existsSync(ghidraOutC)) {
                const candidateC = await readFile(ghidraOutC, "utf8");
                const candidateCBytes = Buffer.byteLength(candidateC, "utf8");
                const remainingModulesCount =
                  modulesToProcess.length - moduleSeq;
                const reservedScaffoldBytes = remainingModulesCount * 4096;
                if (
                  candidateCBytes > 0 &&
                  totalStagedCBytes +
                    headerBytes.length +
                    candidateCBytes +
                    reservedScaffoldBytes <=
                    MAX_DECOMPILE_TOTAL_BYTES
                ) {
                  cContent = candidateC;
                  cGenerator = "ghidra";
                  ghidraEngineUsed = true;
                }
              }
            } else if (exporterOutcome?.status === "no_functions") {
              if ((exporterOutcome.failed_functions ?? 0) > 0) {
                isCoveragePartial = true;
              }
              const noFuncMsg = `Ghidra C decompilation for ${safeLimitationModName} found no usable functions (${exporterOutcome.failed_functions ?? 0} failed); generated entry point scaffolding instead.`;
              if (recordedGhidraFailures < MAX_GHIDRA_FAILURE_DIAGNOSTICS) {
                effectiveLimitations.push(noFuncMsg);
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
            } else if (exporterOutcome?.status === "failed") {
              isCoveragePartial = true;
              const errDetail = exporterOutcome.error
                ? sanitizeDiag(exporterOutcome.error)
                : "export failed";
              const failedMsg = `Ghidra C decompilation for ${safeLimitationModName} failed: ${errDetail}`;
              if (recordedGhidraFailures < MAX_GHIDRA_FAILURE_DIAGNOSTICS) {
                effectiveLimitations.push(failedMsg);
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
            } else if (
              (exporterOutcome == null ||
                exporterOutcome.status === "success") &&
              ghidraOutC &&
              existsSync(ghidraOutC)
            ) {
              const cStat = await stat(ghidraOutC);
              const remainingModulesCount = modulesToProcess.length - moduleSeq;
              const reservedScaffoldBytes = remainingModulesCount * 4096;
              const remainingCBytes =
                MAX_DECOMPILE_TOTAL_BYTES -
                totalStagedCBytes -
                headerBytes.length -
                reservedScaffoldBytes;
              if (cStat.size > remainingCBytes) {
                isCoveragePartial = true;
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
                isCoveragePartial = true;
                const perModuleLimit = formatDecompileBudgetLimit(
                  safeLimitationModName,
                  MAX_DECOMPILE_MODULE_BYTES,
                );
                if (!effectiveLimitations.includes(perModuleLimit)) {
                  effectiveLimitations.push(perModuleLimit);
                }
              } else {
                const candidateC = await readFile(ghidraOutC, "utf8");
                const candidateCBytes = Buffer.byteLength(candidateC, "utf8");
                if (
                  totalStagedCBytes +
                    headerBytes.length +
                    candidateCBytes +
                    reservedScaffoldBytes <=
                  MAX_DECOMPILE_TOTAL_BYTES
                ) {
                  cContent = candidateC;
                  cGenerator = "ghidra";
                  ghidraEngineUsed = true;
                  const failedCount = exporterOutcome?.failed_functions ?? 0;
                  if (
                    failedCount > 0 ||
                    candidateC.includes(
                      "/* WARNING: Failed to decompile function",
                    )
                  ) {
                    isCoveragePartial = true;
                    const incompleteMsg =
                      failedCount > 0
                        ? `Ghidra C decompilation for ${safeLimitationModName} was incomplete; ${failedCount} function(s) failed to decompile.`
                        : `Ghidra C decompilation for ${safeLimitationModName} was incomplete; one or more functions failed to decompile.`;
                    if (!effectiveLimitations.includes(incompleteMsg)) {
                      effectiveLimitations.push(incompleteMsg);
                    }
                  }
                } else if (
                  !effectiveLimitations.includes(
                    "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                  )
                ) {
                  isCoveragePartial = true;
                  effectiveLimitations.push(
                    "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                  );
                }
              }
            } else if (ghidraBin !== null && !ghidraBatchFailed) {
              isCoveragePartial = true;
              const reason =
                exporterOutcome?.error ??
                "decompilation script produced no output";
              const noOutputMsg = `Ghidra C decompilation for ${safeLimitationModName} failed: ${reason}.`;
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
          }

          let finalHeaderBytes: Buffer;
          let finalCBytes: Buffer;
          const OMIT_HEADER_COMMENT =
            "/* UEFI Module Header omitted: reached 64 MiB aggregate staging budget */\n";
          const OMIT_C_COMMENT =
            "/* Decompiled C output omitted: reached 64 MiB aggregate staging budget */\n";
          const omitHeaderBytesLen = Buffer.byteLength(
            OMIT_HEADER_COMMENT,
            "utf8",
          );
          const omitCBytesLen = Buffer.byteLength(OMIT_C_COMMENT, "utf8");

          if (cContent !== null) {
            const candidateBytes = Buffer.from(cContent, "utf8");
            if (
              totalStagedCBytes + headerBytes.length + candidateBytes.length <=
              MAX_DECOMPILE_TOTAL_BYTES
            ) {
              finalHeaderBytes = headerBytes;
              finalCBytes = candidateBytes;
              totalStagedCBytes += headerBytes.length + candidateBytes.length;
            } else {
              isCoveragePartial = true;
              if (
                !effectiveLimitations.includes(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                )
              ) {
                effectiveLimitations.push(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                );
              }
              if (
                totalStagedCBytes + omitHeaderBytesLen + omitCBytesLen <=
                MAX_DECOMPILE_TOTAL_BYTES
              ) {
                finalHeaderBytes = Buffer.from(OMIT_HEADER_COMMENT, "utf8");
                finalCBytes = Buffer.from(OMIT_C_COMMENT, "utf8");
                totalStagedCBytes += omitHeaderBytesLen + omitCBytesLen;
              } else {
                finalHeaderBytes = Buffer.alloc(0);
                finalCBytes = Buffer.alloc(0);
              }
            }
          } else {
            const candidateScaffold = [
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
            const scaffoldBytes = Buffer.from(candidateScaffold, "utf8");
            const combinedFallbackBytes =
              headerBytes.length + scaffoldBytes.length;

            if (
              totalStagedCBytes + combinedFallbackBytes <=
              MAX_DECOMPILE_TOTAL_BYTES
            ) {
              finalHeaderBytes = headerBytes;
              finalCBytes = scaffoldBytes;
              totalStagedCBytes += combinedFallbackBytes;
            } else {
              isCoveragePartial = true;
              if (
                !effectiveLimitations.includes(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                )
              ) {
                effectiveLimitations.push(
                  "Decompiled C output truncated after reaching 64 MiB aggregate staging budget.",
                );
              }
              if (
                totalStagedCBytes + omitHeaderBytesLen + omitCBytesLen <=
                MAX_DECOMPILE_TOTAL_BYTES
              ) {
                finalHeaderBytes = Buffer.from(OMIT_HEADER_COMMENT, "utf8");
                finalCBytes = Buffer.from(OMIT_C_COMMENT, "utf8");
                totalStagedCBytes += omitHeaderBytesLen + omitCBytesLen;
              } else {
                finalHeaderBytes = Buffer.alloc(0);
                finalCBytes = Buffer.alloc(0);
              }
            }
          }

          headerSha256 = sha256Hex(finalHeaderBytes);
          publicationEntries.push({
            relativePath: headerRelPath,
            bytes: finalHeaderBytes,
          });

          const cSha256 = sha256Hex(finalCBytes);
          publicationEntries.push({
            relativePath: cRelPath,
            bytes: finalCBytes,
          });

          stagedModules.push({
            occurrence,
            guid: mod.guid,
            name: mod.rawName,
            phase: mod.phase,
            ...(mod.typeName !== undefined ? { type: mod.typeName } : {}),
            ...(mod.sourceRelPath !== undefined || mod.sourcePath !== undefined
              ? { source_path: mod.sourceRelPath ?? mod.sourcePath }
              : {}),
            ...(mod.sourceLogicalPath !== undefined
              ? { source_logical_path: mod.sourceLogicalPath }
              : {}),
            ...(mod.sourceStream !== undefined
              ? { source_stream: mod.sourceStream }
              : {}),
            ...(mod.sourceRange !== undefined
              ? { source_range: mod.sourceRange }
              : {}),
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
            if (outcomeFile !== undefined) {
              await rm(outcomeFile, { force: true });
            }
            if (isMultiModuleBatch) {
              await rm(join(ghidraBatchInputDir, `mod_${moduleSeq}.efi`), {
                force: true,
              });
            }
          } catch {
            // Ignore scratch unlink error
          }
        }
      }

      if (ghidraEngineUsed && ghidraVersion !== null) {
        const releaseLimitation =
          unverifiedGhidraBuildLimitation(ghidraVersion);
        if (
          releaseLimitation !== undefined &&
          !effectiveLimitations.includes(releaseLimitation)
        ) {
          effectiveLimitations.push(releaseLimitation);
        }
        for (const defectLim of ghidraKnownProviderDefectLimitations(
          ghidraVersion,
        )) {
          if (!effectiveLimitations.includes(defectLim)) {
            effectiveLimitations.push(defectLim);
          }
        }
      }

      const manifestData = {
        image_sha256: imageSha256,
        coverage: isCoveragePartial ? "partial" : "complete",
        source_coverage: sourceCoverage ?? coverage,
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
          ? [
              "",
              "## Limitations",
              ...effectiveLimitations.map(
                (l) =>
                  `- ${l
                    .replace(/\0/g, " ")
                    .replace(/[\x00-\x1f\x7f]+/g, " ")
                    .replace(/[\r\n]+/g, " ")}`,
              ),
            ]
          : []),
        "",
        "## Modules Index",
        "| Phase | Name | GUID | Size (Bytes) | Disassembly Status | C Scaffold | Disassembly |",
        "|---|---|---|---|---|---|---|",
        ...stagedModules.map((m) => {
          const safeDisplayName = ellipsisExcerpt(m.name, 256);
          const safeCellName = formatMarkdownCodeSpan(
            safeDisplayName.replace(/\|/g, "\\|"),
          );
          const safeGuid = formatMarkdownCodeSpan(
            (m.guid ?? "N/A").replace(/\|/g, "\\|"),
          );
          const safeLinkName = m.name
            .slice(0, 256)
            .replace(/\0/g, " ")
            .replace(/[\x00-\x1f\x7f]+/g, " ")
            .replace(/[\r\n]+/g, " ")
            .replace(/[[\]|`]/g, "_");
          return `| ${m.phase} | ${safeCellName} | ${safeGuid} | ${m.code_bytes} | ${m.disassembly_status} | [${safeLinkName}.c](${m.relative_c_file}) | ${m.relative_asm_file ? `[${safeLinkName}.asm](${m.relative_asm_file})` : "N/A"} |`;
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

          let disassemblerProducer: string = "none";
          if (input.include_disassembly) {
            if (usedDisassemblers.size > 1) {
              disassemblerProducer = "mixed";
            } else if (usedDisassemblers.size === 1) {
              disassemblerProducer = [...usedDisassemblers][0]!;
            }
          }

          const moduleRelativePaths = new Set<string>();
          for (const m of stagedModules) {
            moduleRelativePaths.add(m.relative_c_file);
            moduleRelativePaths.add(m.relative_header_file);
            if (m.relative_asm_file !== null) {
              moduleRelativePaths.add(m.relative_asm_file);
            }
            if (m.relative_payload_file !== null) {
              moduleRelativePaths.add(m.relative_payload_file);
            }
          }
          const nonduplicateReceipts = receipts
            .filter((r) => !moduleRelativePaths.has(r.relativePath))
            .slice(0, 100)
            .map((r) => ({
              relative_path: r.relativePath,
              path: r.path,
              size: r.size,
              sha256: r.sha256,
            }));

          return uefiResultSchemas.decompile_uefi_firmware.parse({
            parser: {
              name: "rea-uefi",
              version: UEFI_PROVIDER_IDENTITY.version,
            },
            image_sha256: imageSha256,
            output_directory: outputRoot,
            coverage:
              isCoveragePartial ||
              stagedModules.length < discoveredModules.length
                ? "partial"
                : "complete",
            total_modules_found: discoveredModules.length,
            total_modules_decompiled: stagedModules.length,
            phases: phaseCounts,
            modules: finalModules,
            producers: {
              ghidra: ghidraEngineUsed ? (ghidraVersion ?? ghidraBin) : null,
              disassembler: disassemblerProducer,
            },
            receipts: nonduplicateReceipts,
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

      const primaryError =
        establishedError instanceof AnalysisError
          ? establishedError
          : establishedError !== undefined
            ? classifyProviderFailure(
                establishedError,
                uefiFailureDialect(request.operation, input.path),
              )
            : undefined;

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

        const cancellationError: AnalysisError =
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

        if (primaryError !== undefined) {
          let composedPrimary = primaryError;
          if (cleanupError !== undefined) {
            composedPrimary = analysisErrorWithCleanupDependencies(
              composedPrimary,
              cleanupError,
              "decompile_uefi_firmware",
            );
          }
          if (cancellationError instanceof AnalysisCancelledError) {
            throw analysisErrorWithCancellation(
              composedPrimary,
              cancellationError,
            );
          }
          composedPrimary.retainSecondaryFailure(cancellationError);
          throw composedPrimary;
        }

        if (cleanupError !== undefined) {
          throw analysisErrorWithCleanupDependencies(
            cancellationError,
            cleanupError,
            "decompile_uefi_firmware",
          );
        }
        throw cancellationError;
      }

      if (cleanupError !== undefined) {
        if (primaryError !== undefined) {
          throw analysisErrorWithCleanupDependencies(
            primaryError,
            cleanupError,
            "decompile_uefi_firmware",
          );
        }
        throw cleanupError;
      }

      if (
        primaryError !== undefined &&
        !(establishedError instanceof AnalysisError)
      ) {
        throw primaryError;
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

              const phase = phaseFromFfsTypeName(file.type_name) ?? "MISC";

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
                const effectivePhase =
                  requested !== "all" &&
                  file.type_name &&
                  isPhaseSupportedByFfsType(
                    requested.toUpperCase(),
                    file.type_name,
                  )
                    ? (requested.toUpperCase() as
                        | "SEC"
                        | "PEI"
                        | "DXE"
                        | "SMM"
                        | "APP"
                        | "MISC")
                    : phase;

                discoveredModules.push({
                  guid: file.guid,
                  rawName,
                  cleanName,
                  typeName: file.type_name,
                  phase: effectivePhase,
                  sourceLogicalPath: section.logical_path,
                  sourceStream: payload.sourceStream,
                  sourceRange: payload.range ?? {
                    offset: section.offset + section.header_length,
                    length: payload.bytes.length,
                  },
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
      undefined,
      scan.coverage,
    );
  }

  async #decompileDirectory(
    request: Extract<UefiRequest, { operation: "decompile_uefi_firmware" }>,
    signal: AbortSignal,
    checkpoint: () => void,
    remainingTimeMs?: () => number,
  ): Promise<AnalysisExecution> {
    const input = request.input;
    const canonicalInput = await realpath(input.path).catch(() => input.path);
    const { canonicalOutput } = await SafeOutputTree.resolveDestination(
      input.output_directory,
    ).catch((cause: unknown) => {
      throw outputDirectoryAdmissionRefusal(
        request.operation,
        "output_directory",
        cause,
      );
    });
    if (
      isPathWithinRoot(canonicalInput, canonicalOutput) ||
      canonicalInput === canonicalOutput
    ) {
      throw outputDirectoryAdmissionRefusal(
        request.operation,
        "output_directory",
        new SafeOutputTreeDestinationRefusal(
          `Decompilation output directory ${canonicalOutput} is inside or identical to directory input ${canonicalInput}. Choose a directory outside the source.`,
        ),
      );
    }
    const MAX_DIRECTORY_INVENTORY_ENTRIES = 10_000;
    const limitations: string[] = [];

    const reader = new DirectoryArtifactReader(input.path, "omit");
    let establishedError: unknown | undefined;
    let publishedResult: UefiDecompileResult | undefined;
    let dirSha256 = "";
    try {
      let manifestEntry: DirectoryArtifactEntry | undefined;
      const candidateEntries: DirectoryArtifactEntry[] = [];
      let traversalLimitReached = false;
      let hasUnknownCoverage = false;
      let isCoveragePartial = false;
      interface OmittedDirectoryCandidate {
        readonly identityRelPath: string;
        readonly reason: string;
      }
      const omittedCandidates: OmittedDirectoryCandidate[] = [];

      try {
        for await (const entry of reader.entries(signal, {
          maximumEntries: MAX_DIRECTORY_INVENTORY_ENTRIES,
          onCoverage: (coverage) => {
            if (coverage.status === "unknown") {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
            }
            for (const lim of coverage.limitations) {
              if (limitations.length < 50) limitations.push(lim);
            }
          },
          onOmission: (omission) => {
            isCoveragePartial = true;
            const identityRelPath =
              HOST_PLATFORM.platform === "win32"
                ? omission.path.replaceAll("\\", "/")
                : omission.path;
            omittedCandidates.push({
              identityRelPath,
              reason: `omission:${omission.kind}`,
            });
            if (limitations.length < 50) {
              const safePath = formatMarkdownCodeSpan(omission.path);
              limitations.push(`Omitted unreadable path: ${safePath}`);
            }
          },
        })) {
          checkpoint();
          signal.throwIfAborted();
          if (entry.kind === "file") {
            if (entry.path === "firmware_manifest.json") {
              manifestEntry = entry;
            } else {
              candidateEntries.push(entry);
            }
          } else if (entry.kind === "symlink") {
            isCoveragePartial = true;
            const identityRelPath =
              HOST_PLATFORM.platform === "win32"
                ? entry.path.replaceAll("\\", "/")
                : entry.path;
            omittedCandidates.push({
              identityRelPath,
              reason: "symlink",
            });
            if (limitations.length < 50) {
              const safePath = formatMarkdownCodeSpan(entry.path);
              limitations.push(`Omitted symlink entry: ${safePath}`);
            }
          }
        }
      } catch (dirErr: unknown) {
        if (dirErr instanceof DirectoryArtifactTraversalLimit) {
          traversalLimitReached = true;
          limitations.push(
            `Directory discovery stopped after reaching ${MAX_DIRECTORY_INVENTORY_ENTRIES} entry budget.`,
          );
        } else if (dirErr instanceof DirectoryArtifactRootFailure) {
          throw new Error(
            `Selected directory root is not accessible: ${errorMessage(dirErr)}`,
          );
        } else {
          throw dirErr;
        }
      }

      candidateEntries.sort((a, b) => compareUnicodeCodePoints(a.path, b.path));

      const guidRegex =
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
      const embeddedGuidRegex =
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

      type ManifestModuleEntry = {
        guid?: string | null | undefined;
        name?: string | undefined;
        phase?: string | undefined;
        type?: string | undefined;
        payloadSha256?: string | undefined;
      };
      const isWindows = HOST_PLATFORM.platform === "win32";
      const manifestModulesByExactRelPath = new Map<
        string,
        ManifestModuleEntry
      >();
      const manifestModulesByFoldedRelPath = new Map<
        string,
        ManifestModuleEntry
      >();
      const manifestModulesByFallbackRelPath = new Map<
        string,
        ManifestModuleEntry
      >();
      const ambiguousCrossPlatformKeys = new Set<string>();
      interface ManifestPayloadEntry {
        readonly payloadFile: string;
        readonly exactNorm: string;
        readonly record: ManifestModuleEntry;
      }
      const declaredManifestPayloads: ManifestPayloadEntry[] = [];
      const matchedManifestPayloads = new Set<ManifestModuleEntry>();
      let manifestSha256: string | null = null;
      let declaredDecompiledCount: number | undefined;

      if (manifestEntry !== undefined) {
        const declared = manifestEntry.declaredSize ?? 0;
        const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
        if (declared > MANIFEST_MAX_BYTES) {
          isCoveragePartial = true;
          limitations.push(
            `Manifest firmware_manifest.json exceeds size limit (${MANIFEST_MAX_BYTES} bytes); ignoring manifest.`,
          );
          omittedCandidates.push({
            identityRelPath: "firmware_manifest.json",
            reason: `manifest_size_limit:${declared}`,
          });
        } else {
          try {
            const stream = await reader.open(manifestEntry, signal);
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of stream) {
              const b = chunk as Buffer;
              total += b.length;
              if (total > MANIFEST_MAX_BYTES) {
                isCoveragePartial = true;
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json",
                  reason: `manifest_size_limit:${total}`,
                });
                if (
                  "destroy" in stream &&
                  typeof stream.destroy === "function"
                ) {
                  stream.destroy();
                }
                throw new Error(
                  `Manifest firmware_manifest.json exceeded size limit (${MANIFEST_MAX_BYTES} bytes)`,
                );
              }
              chunks.push(b);
            }
            const manifestRaw = Buffer.concat(chunks);
            manifestSha256 = sha256Hex(manifestRaw);
            const parsed = JSON.parse(manifestRaw.toString("utf8"));
            if (
              typeof parsed?.total_modules_found === "number" &&
              typeof parsed?.total_modules_decompiled === "number"
            ) {
              declaredDecompiledCount = parsed.total_modules_decompiled;
              if (
                parsed.total_modules_found > parsed.total_modules_decompiled
              ) {
                isCoveragePartial = true;
                const omittedCount =
                  parsed.total_modules_found - parsed.total_modules_decompiled;
                if (limitations.length < 50) {
                  limitations.push(
                    `Manifest firmware_manifest.json declares ${omittedCount} omitted module(s) (${parsed.total_modules_decompiled} of ${parsed.total_modules_found} decompiled).`,
                  );
                }
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json#omitted_modules",
                  reason: `declared_omissions:${omittedCount}`,
                });
              }
            } else if (typeof parsed?.total_modules_decompiled === "number") {
              declaredDecompiledCount = parsed.total_modules_decompiled;
            }
            const rawSourceCov = parsed?.source_coverage;
            const rawCov = parsed?.coverage;

            if (rawSourceCov === "complete") {
              // Validated source completeness clears legacy tool export limits
            } else if (rawSourceCov === "partial") {
              isCoveragePartial = true;
              if (limitations.length < 50) {
                limitations.push(
                  "Manifest firmware_manifest.json declares partial source coverage.",
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#source_coverage",
                reason: "partial_source_coverage",
              });
            } else if (rawSourceCov === "unknown") {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
              if (limitations.length < 50) {
                limitations.push(
                  "Manifest firmware_manifest.json declares unknown source coverage.",
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#source_coverage",
                reason: "unknown_source_coverage",
              });
            } else if (rawSourceCov !== undefined) {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
              const formattedVal =
                typeof rawSourceCov === "string"
                  ? rawSourceCov
                  : (JSON.stringify(rawSourceCov) ?? String(rawSourceCov));
              if (limitations.length < 50) {
                limitations.push(
                  `Manifest firmware_manifest.json declares unrecognized source coverage "${formatMarkdownCodeSpan(ellipsisExcerpt(formattedVal, 32))}".`,
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#source_coverage",
                reason: "unrecognized_source_coverage",
              });
            } else if (rawCov === "partial") {
              isCoveragePartial = true;
              if (limitations.length < 50) {
                limitations.push(
                  "Manifest firmware_manifest.json declares partial coverage.",
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#coverage",
                reason: "partial_coverage",
              });
            } else if (rawCov === "unknown") {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
              if (limitations.length < 50) {
                limitations.push(
                  "Manifest firmware_manifest.json declares unknown coverage.",
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#coverage",
                reason: "unknown_coverage",
              });
            } else if (rawCov !== undefined && rawCov !== "complete") {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
              const formattedVal =
                typeof rawCov === "string"
                  ? rawCov
                  : (JSON.stringify(rawCov) ?? String(rawCov));
              if (limitations.length < 50) {
                limitations.push(
                  `Manifest firmware_manifest.json declares unrecognized coverage "${formatMarkdownCodeSpan(ellipsisExcerpt(formattedVal, 32))}".`,
                );
              }
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json#coverage",
                reason: "unrecognized_coverage",
              });
            }
            if (Array.isArray(parsed?.modules)) {
              const MAX_MANIFEST_MODULES = 10_000;
              const moduleCount = parsed.modules.length;
              if (
                moduleCount > MAX_MANIFEST_MODULES &&
                limitations.length < 50
              ) {
                limitations.push(
                  `Manifest firmware_manifest.json module count truncated to ${MAX_MANIFEST_MODULES} entries.`,
                );
              }
              const admittedCount = Math.min(moduleCount, MAX_MANIFEST_MODULES);
              for (let mIdx = 0; mIdx < admittedCount; mIdx++) {
                if (mIdx % 100 === 0) {
                  checkpoint();
                  signal.throwIfAborted();
                }
                const m = parsed.modules[mIdx];
                if (!m || typeof m !== "object") continue;
                if (m.payload_file === null || m.payload_file === undefined) {
                  isCoveragePartial = true;
                  const label =
                    typeof m.name === "string" &&
                    m.name.length > 0 &&
                    m.name.length <= 256
                      ? m.name
                      : `module_${mIdx}`;
                  omittedCandidates.push({
                    identityRelPath: `firmware_manifest.json#${label}`,
                    reason: "null_payload",
                  });
                  continue;
                }
                if (
                  typeof m.payload_file !== "string" ||
                  m.payload_file.length === 0 ||
                  m.payload_file.length > 4096
                ) {
                  if (
                    typeof m.payload_file === "string" &&
                    m.payload_file.length > 4096 &&
                    limitations.length < 50
                  ) {
                    limitations.push(
                      `Manifest module at index ${mIdx} has excessive payload_file path length (> 4096 bytes); ignored.`,
                    );
                  }
                  continue;
                }
                const exactNorm = isWindows
                  ? m.payload_file.replace(/[/\\]+/g, "/")
                  : m.payload_file.replace(/\/+/g, "/");
                const foldedNorm = exactNorm.toLowerCase();
                const crossPlatformNorm = m.payload_file.replace(
                  /[/\\]+/g,
                  "/",
                );
                const crossPlatformFolded = crossPlatformNorm.toLowerCase();

                let validGuid: string | null | undefined = undefined;
                if (m.guid !== undefined && m.guid !== null) {
                  if (typeof m.guid === "string" && guidRegex.test(m.guid)) {
                    validGuid = m.guid.toLowerCase();
                  } else if (limitations.length < 50) {
                    limitations.push(
                      `Manifest module at index ${mIdx} has invalid GUID format; using payload-derived fallback.`,
                    );
                  }
                } else if (m.guid === null) {
                  validGuid = null;
                }

                const MAX_MANIFEST_NAME_LENGTH = 65_536;
                let validName: string | undefined = undefined;
                if (typeof m.name === "string" && m.name.length > 0) {
                  if (m.name.length <= MAX_MANIFEST_NAME_LENGTH) {
                    validName = m.name;
                  } else {
                    isCoveragePartial = true;
                    if (limitations.length < 50) {
                      limitations.push(
                        `Manifest module at index ${mIdx} has excessive name length (> ${MAX_MANIFEST_NAME_LENGTH} chars); using filename fallback.`,
                      );
                    }
                  }
                } else if (m.name !== undefined && limitations.length < 50) {
                  limitations.push(
                    `Manifest module at index ${mIdx} has non-string name; using filename fallback.`,
                  );
                }

                const MAX_MANIFEST_PHASE_LENGTH = 32;
                let validPhase: string | undefined = undefined;
                if (typeof m.phase === "string") {
                  const trimmedPhase = m.phase.trim();
                  if (trimmedPhase.length <= MAX_MANIFEST_PHASE_LENGTH) {
                    const upperPhase = trimmedPhase.toUpperCase();
                    if (
                      ["SEC", "PEI", "DXE", "SMM", "APP", "MISC"].includes(
                        upperPhase,
                      )
                    ) {
                      validPhase = upperPhase;
                    } else if (limitations.length < 50) {
                      limitations.push(
                        `Manifest module at index ${mIdx} has unrecognized phase "${formatMarkdownCodeSpan(ellipsisExcerpt(trimmedPhase, 32))}"; using path-derived fallback.`,
                      );
                    }
                  } else if (limitations.length < 50) {
                    limitations.push(
                      `Manifest module at index ${mIdx} has oversized phase (${trimmedPhase.length} chars); using path-derived fallback.`,
                    );
                  }
                } else if (m.phase !== undefined && limitations.length < 50) {
                  limitations.push(
                    `Manifest module at index ${mIdx} has non-string phase; using path-derived fallback.`,
                  );
                }

                const MAX_MANIFEST_TYPE_LENGTH = 128;
                let candidateType: string | undefined = undefined;
                if (typeof m.type === "string" && m.type.length > 0) {
                  candidateType = m.type;
                } else if (
                  typeof m.typeName === "string" &&
                  m.typeName.length > 0
                ) {
                  candidateType = m.typeName;
                } else if (
                  typeof m.type_name === "string" &&
                  m.type_name.length > 0
                ) {
                  candidateType = m.type_name;
                }

                let validType: string | undefined = undefined;
                if (candidateType !== undefined) {
                  const trimmedType = candidateType.trim();
                  if (
                    trimmedType.length > 0 &&
                    trimmedType.length <= MAX_MANIFEST_TYPE_LENGTH
                  ) {
                    validType = trimmedType;
                  } else if (trimmedType.length > MAX_MANIFEST_TYPE_LENGTH) {
                    isCoveragePartial = true;
                    if (limitations.length < 50) {
                      limitations.push(
                        `Manifest module at index ${mIdx} has excessive type length (> ${MAX_MANIFEST_TYPE_LENGTH} chars); ignoring manifest type.`,
                      );
                    }
                  }
                }

                let validPayloadSha256: string | undefined = undefined;
                const rawSha = m.payload_sha256 ?? m.payloadSha256 ?? m.sha256;
                if (rawSha !== undefined && rawSha !== null) {
                  if (
                    typeof rawSha === "string" &&
                    /^[0-9a-f]{64}$/i.test(rawSha.trim())
                  ) {
                    validPayloadSha256 = rawSha.trim().toLowerCase();
                  } else {
                    isCoveragePartial = true;
                    if (limitations.length < 50) {
                      limitations.push(
                        `Manifest payload_sha256 for ${ellipsisExcerpt(String(m.payload_file ?? exactNorm), 128)} is malformed; manifest row metadata ignored.`,
                      );
                    }
                    continue;
                  }
                }

                const manifestEntryRecord: ManifestModuleEntry = {
                  guid: validGuid,
                  name: validName,
                  phase: validPhase,
                  type: validType,
                  payloadSha256: validPayloadSha256,
                };
                manifestModulesByExactRelPath.set(
                  exactNorm,
                  manifestEntryRecord,
                );
                declaredManifestPayloads.push({
                  payloadFile: m.payload_file,
                  exactNorm,
                  record: manifestEntryRecord,
                });
                if (!manifestModulesByFoldedRelPath.has(foldedNorm)) {
                  manifestModulesByFoldedRelPath.set(
                    foldedNorm,
                    manifestEntryRecord,
                  );
                }
                if (!isWindows) {
                  const registerFallbackKey = (key: string) => {
                    const existing = manifestModulesByFallbackRelPath.get(key);
                    if (
                      existing !== undefined &&
                      existing !== manifestEntryRecord
                    ) {
                      ambiguousCrossPlatformKeys.add(key);
                    } else {
                      manifestModulesByFallbackRelPath.set(
                        key,
                        manifestEntryRecord,
                      );
                    }
                  };
                  registerFallbackKey(crossPlatformNorm);
                }
              }
              if (
                declaredDecompiledCount !== undefined &&
                declaredManifestPayloads.length < declaredDecompiledCount
              ) {
                isCoveragePartial = true;
                const missingRowCount =
                  declaredDecompiledCount - declaredManifestPayloads.length;
                if (limitations.length < 50) {
                  limitations.push(
                    `Manifest firmware_manifest.json declares ${declaredDecompiledCount} decompiled module(s) but contains only ${declaredManifestPayloads.length} valid module payload row(s).`,
                  );
                }
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json#missing_module_rows",
                  reason: `missing_module_rows:${missingRowCount}`,
                });
              }
            } else {
              isCoveragePartial = true;
              hasUnknownCoverage = true;
              if (parsed?.modules !== undefined) {
                if (limitations.length < 50) {
                  limitations.push(
                    "Manifest firmware_manifest.json contains a malformed (non-array) modules inventory.",
                  );
                }
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json#modules",
                  reason: "malformed_modules_inventory",
                });
              } else if (
                declaredDecompiledCount !== undefined &&
                declaredDecompiledCount > 0
              ) {
                if (limitations.length < 50) {
                  limitations.push(
                    `Manifest firmware_manifest.json declares ${declaredDecompiledCount} decompiled module(s) but contains no module array.`,
                  );
                }
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json#missing_module_rows",
                  reason: `missing_module_rows:${declaredDecompiledCount}`,
                });
              } else {
                if (limitations.length < 50) {
                  limitations.push(
                    "Manifest firmware_manifest.json contains no modules inventory array.",
                  );
                }
                omittedCandidates.push({
                  identityRelPath: "firmware_manifest.json#modules",
                  reason: "missing_modules_inventory",
                });
              }
            }
          } catch (manifestErr) {
            isCoveragePartial = true;
            limitations.push(
              `Failed to parse firmware_manifest.json: ${errorMessage(manifestErr)}`,
            );
            if (
              !omittedCandidates.some(
                (o) => o.identityRelPath === "firmware_manifest.json",
              )
            ) {
              omittedCandidates.push({
                identityRelPath: "firmware_manifest.json",
                reason: "manifest_parse_failure",
              });
            }
          }
        }
      }

      interface AdmittedCandidateModule {
        readonly entry: DirectoryArtifactEntry;
        readonly fullPath: string;
        readonly identityRelPath: string;
        readonly name: string;
        readonly size: number;
        phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC";
        typeName?: string | undefined;
        guid: string | null;
        rawName: string;
        cleanName: string;
        readonly fallbackPhase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC";
        readonly fallbackGuid: string | null;
        readonly fallbackRawName: string;
        readonly fallbackCleanName: string;
        readonly fromManifest?: ManifestModuleEntry | undefined;
      }
      const admittedCandidates: AdmittedCandidateModule[] = [];

      const candidateCrossPlatformKeys = new Map<string, string>();
      const ambiguousDirectoryInventoryKeys = new Set<string>();
      if (!isWindows) {
        for (const cEntry of candidateEntries) {
          const normK = cEntry.path.split(/[/\\]+/).join("/");
          const existing = candidateCrossPlatformKeys.get(normK);
          if (existing !== undefined && existing !== cEntry.path) {
            ambiguousDirectoryInventoryKeys.add(normK);
          } else {
            candidateCrossPlatformKeys.set(normK, cEntry.path);
          }
        }
      }

      for (const entry of candidateEntries) {
        checkpoint();
        signal.throwIfAborted();

        const size = entry.declaredSize ?? 0;
        if (size > 32 * 1024 * 1024) {
          const identityRelPath =
            HOST_PLATFORM.platform === "win32"
              ? entry.path.replaceAll("\\", "/")
              : entry.path;
          omittedCandidates.push({
            identityRelPath,
            reason: `oversized:${size}`,
          });
          if (limitations.length < 50) {
            limitations.push(
              `Candidate file ${entry.path} exceeds maximum module size limit (32 MiB).`,
            );
          }
          continue;
        }
        if (size < 40) continue;

        const isPeOrTe = await reader
          .inspectFile(
            entry,
            async (fileHandle) => {
              const probeLen = Math.min(size, 4096);
              const headerBuf = Buffer.alloc(probeLen);
              const { bytesRead } = await fileHandle.read(
                headerBuf,
                0,
                probeLen,
                0,
              );
              if (bytesRead < 40) return false;
              if (headerBuf[0] === 0x56 && headerBuf[1] === 0x5a) {
                // Terse Executable ("VZ")
                const r = new BinaryReader(
                  headerBuf,
                  true,
                  "UEFI candidate TE header",
                );
                const machine = r.u16(2);
                const numSections = r.u8(4);
                return machine !== 0 && numSections > 0;
              }
              if (
                headerBuf[0] === 0x4d &&
                headerBuf[1] === 0x5a &&
                bytesRead >= 64
              ) {
                // Portable Executable ("MZ")
                const r = new BinaryReader(
                  headerBuf,
                  true,
                  "UEFI candidate PE DOS header",
                );
                const eLfanew = r.u32(60);
                if (eLfanew >= 64 && eLfanew + 24 <= size) {
                  let peHeaderBuf: Buffer | undefined;
                  if (eLfanew + 24 <= bytesRead) {
                    peHeaderBuf = headerBuf.subarray(eLfanew, eLfanew + 24);
                  } else {
                    const extraBuf = Buffer.alloc(24);
                    const { bytesRead: extraRead } = await fileHandle.read(
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
                      return machine !== 0 && numSections > 0;
                    }
                  }
                }
              }
              return false;
            },
            signal,
          )
          .catch((sniffErr: unknown) => {
            if (sniffErr instanceof ArtifactFileCleanupFailure) {
              const leases = sniffErr.cleanupLeases ?? [];
              const cleanupErr = new ProviderCleanupError(
                UEFI_PROVIDER_IDENTITY.id,
                leases.flatMap((l) => l.cleanupResources ?? [entry.adapterKey]),
                { reason: errorMessage(sniffErr.cause) },
                {
                  cause: sniffErr.cause,
                  operation: "decompile_uefi_firmware",
                },
              );
              new AnalysisCleanupLeaseGroup(cleanupErr, leases);
              throw cleanupErr;
            }
            const identityRelPath =
              HOST_PLATFORM.platform === "win32"
                ? entry.path.replaceAll("\\", "/")
                : entry.path;
            omittedCandidates.push({
              identityRelPath,
              reason: "unreadable",
            });
            if (limitations.length < 50) {
              limitations.push(
                `Candidate file ${basename(entry.path)} could not be read: ${errorMessage(sniffErr)}`,
              );
            }
            return false;
          });

        if (!isPeOrTe) continue;

        const relPath = entry.path;
        const fullPath = entry.adapterKey;
        const entryName = basename(relPath);
        const identityRelPath =
          HOST_PLATFORM.platform === "win32"
            ? relPath.replaceAll("\\", "/")
            : relPath;
        const exactLookupKey = isWindows
          ? relPath.split(/[/\\]+/).join("/")
          : relPath.split(/\/+/).join("/");
        const foldedLookupKey = exactLookupKey.toLowerCase();
        const crossPlatformLookupKey = isWindows
          ? exactLookupKey
          : relPath.split(/[/\\]+/).join("/");
        const crossPlatformFoldedKey = crossPlatformLookupKey.toLowerCase();
        const directoryPath = dirname(relPath);
        const hierarchySegments =
          directoryPath === "." || directoryPath === ""
            ? []
            : (isWindows
                ? directoryPath.split(/[/\\]+/)
                : directoryPath.split("/")
              )
                .map((s) => s.toLowerCase())
                .filter((s) => s.length > 0);
        const fallbackManifestEntry =
          !ambiguousCrossPlatformKeys.has(crossPlatformLookupKey) &&
          !ambiguousDirectoryInventoryKeys.has(crossPlatformLookupKey)
            ? manifestModulesByFallbackRelPath.get(crossPlatformLookupKey)
            : undefined;
        const fromManifest =
          manifestModulesByExactRelPath.get(exactLookupKey) ??
          fallbackManifestEntry ??
          (isWindows
            ? (manifestModulesByFoldedRelPath.get(foldedLookupKey) ??
              (!ambiguousCrossPlatformKeys.has(crossPlatformFoldedKey) &&
              !ambiguousDirectoryInventoryKeys.has(crossPlatformFoldedKey)
                ? manifestModulesByFallbackRelPath.get(crossPlatformFoldedKey)
                : undefined))
            : undefined);
        if (fromManifest !== undefined) {
          matchedManifestPayloads.add(fromManifest);
        }

        const fallbackPhase = hierarchySegments.some((s) => s === "sec")
          ? "SEC"
          : hierarchySegments.some((s) => s === "pei" || s === "peim")
            ? "PEI"
            : hierarchySegments.some((s) => s === "smm")
              ? "SMM"
              : hierarchySegments.some(
                    (s) => s === "app" || s === "application",
                  )
                ? "APP"
                : hierarchySegments.some((s) => s === "dxe")
                  ? "DXE"
                  : "MISC";

        let fallbackGuid: string | null = null;
        const nameMatch = entryName.match(embeddedGuidRegex);
        if (nameMatch && nameMatch[1]) {
          fallbackGuid = nameMatch[1].toLowerCase();
        } else {
          const parentDirName = basename(dirname(fullPath));
          const parentMatch = parentDirName.match(embeddedGuidRegex);
          if (parentMatch && parentMatch[1]) {
            fallbackGuid = parentMatch[1].toLowerCase();
          }
        }

        let fallbackRawName = entryName.replace(/\.(pe|efi|bin|te)$/i, "");
        if (fallbackGuid) {
          const parentBase = basename(dirname(fullPath));
          const prefix = `${fallbackGuid}_`;
          if (parentBase.toLowerCase().startsWith(prefix)) {
            const candidateName = parentBase.slice(prefix.length);
            if (candidateName.length > 0) {
              fallbackRawName = candidateName;
            }
          }
        }
        const fallbackCleanName = fallbackRawName.replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );

        let phase: "SEC" | "PEI" | "DXE" | "SMM" | "APP" | "MISC" =
          fallbackPhase;
        const manifestPhase = fromManifest?.phase?.toUpperCase();
        if (
          manifestPhase &&
          ["SEC", "PEI", "DXE", "SMM", "APP", "MISC"].includes(manifestPhase)
        ) {
          phase = manifestPhase as
            | "SEC"
            | "PEI"
            | "DXE"
            | "SMM"
            | "APP"
            | "MISC";
        } else {
          const typePhase = phaseFromFfsTypeName(fromManifest?.type);
          if (typePhase !== undefined) {
            phase = typePhase;
          }
        }

        let typeName = fromManifest?.type;
        if (
          manifestPhase &&
          typeName &&
          !isPhaseSupportedByFfsType(phase, typeName)
        ) {
          isCoveragePartial = true;
          const safeEntryName = formatMarkdownCodeSpan(
            ellipsisExcerpt(entryName.replace(/[\r\n]+/g, " "), 64),
          );
          if (limitations.length < 50) {
            limitations.push(
              `Manifest row for ${safeEntryName} declares conflicting phase "${manifestPhase}" and type "${typeName}"; neutralized type metadata to preserve ABI consistency with declared phase.`,
            );
          }
          typeName = undefined;
        }

        let guid: string | null = fallbackGuid;
        if (
          fromManifest !== undefined &&
          "guid" in fromManifest &&
          fromManifest.guid !== undefined
        ) {
          guid = fromManifest.guid ? fromManifest.guid.toLowerCase() : null;
        }

        let rawName = fallbackRawName;
        if (
          typeof fromManifest?.name === "string" &&
          fromManifest.name.length > 0
        ) {
          rawName = fromManifest.name;
        } else if (guid) {
          const parentBase = basename(dirname(fullPath));
          const prefix = `${guid}_`;
          if (parentBase.toLowerCase().startsWith(prefix)) {
            const candidateName = parentBase.slice(prefix.length);
            if (candidateName.length > 0) {
              rawName = candidateName;
            }
          }
        }
        const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

        admittedCandidates.push({
          entry,
          fullPath,
          identityRelPath,
          name: entryName,
          size,
          phase,
          typeName,
          guid,
          rawName,
          cleanName,
          fallbackPhase,
          fallbackGuid,
          fallbackRawName,
          fallbackCleanName,
          fromManifest,
        });
      }

      for (const declared of declaredManifestPayloads) {
        if (!matchedManifestPayloads.has(declared.record)) {
          isCoveragePartial = true;
          const safePayload = formatMarkdownCodeSpan(
            ellipsisExcerpt(declared.payloadFile.replace(/[\r\n]+/g, " "), 128),
          );
          if (limitations.length < 50) {
            limitations.push(
              `Manifest payload ${safePayload} was not found or admitted as a valid UEFI candidate module.`,
            );
          }
          const identityRelPath =
            HOST_PLATFORM.platform === "win32"
              ? declared.payloadFile.replaceAll("\\", "/")
              : declared.payloadFile;
          if (
            !omittedCandidates.some(
              (o) => o.identityRelPath === identityRelPath,
            )
          ) {
            omittedCandidates.push({
              identityRelPath,
              reason: "missing_manifest_payload",
            });
          }
        }
      }

      // Sort admitted candidate modules deterministically by Unicode code point order
      admittedCandidates.sort((a, b) =>
        compareUnicodeCodePoints(a.identityRelPath, b.identityRelPath),
      );

      if (
        typeof declaredDecompiledCount === "number" &&
        admittedCandidates.length < declaredDecompiledCount
      ) {
        isCoveragePartial = true;
        const missingCount =
          declaredDecompiledCount - admittedCandidates.length;
        const alreadyReported = limitations.some((l) =>
          l.includes(
            `declares ${declaredDecompiledCount} decompiled module(s)`,
          ),
        );
        if (!alreadyReported && limitations.length < 50) {
          limitations.push(
            `Manifest firmware_manifest.json declares ${declaredDecompiledCount} decompiled module(s) but only ${admittedCandidates.length} candidate module(s) were admitted from directory.`,
          );
        }
        if (
          !omittedCandidates.some((o) =>
            o.identityRelPath.startsWith("firmware_manifest.json#missing_"),
          )
        ) {
          omittedCandidates.push({
            identityRelPath: "firmware_manifest.json#missing_admitted_modules",
            reason: `missing_admitted_modules:${missingCount}`,
          });
        }
      }

      const dirHash = createHash("sha256");
      dirHash.update("manifest:" + (manifestSha256 ?? "none") + "\n");

      const MAX_PRELOAD_BYTES = 32 * 1024 * 1024;
      let retainedPreloadBytes = 0;
      const moduleDataByIdentity = new Map<
        string,
        { bytes?: Buffer | undefined; sha256: string }
      >();

      for (let i = 0; i < admittedCandidates.length; i++) {
        checkpoint();
        signal.throwIfAborted();
        const cand = admittedCandidates[i]!;
        const content = await buffer(await reader.open(cand.entry, signal));
        const fileSha256 = sha256Hex(content);
        dirHash.update(compositeKey([cand.identityRelPath, fileSha256]) + "\n");

        if (
          cand.fromManifest?.payloadSha256 !== undefined &&
          cand.fromManifest.payloadSha256 !== fileSha256
        ) {
          isCoveragePartial = true;
          if (limitations.length < 50) {
            limitations.push(
              `Manifest payload_sha256 mismatch for ${cand.identityRelPath}; manifest row metadata ignored.`,
            );
          }
          cand.guid = cand.fallbackGuid;
          cand.rawName = cand.fallbackRawName;
          cand.cleanName = cand.fallbackCleanName;
          cand.phase = cand.fallbackPhase;
          cand.typeName = undefined;
        }

        let retainedBytes: Buffer | undefined;
        if (retainedPreloadBytes + content.byteLength <= MAX_PRELOAD_BYTES) {
          retainedBytes = content;
          retainedPreloadBytes += content.byteLength;
        }
        moduleDataByIdentity.set(cand.identityRelPath, {
          ...(retainedBytes !== undefined ? { bytes: retainedBytes } : {}),
          sha256: fileSha256,
        });
      }

      omittedCandidates.sort((a, b) =>
        a.identityRelPath < b.identityRelPath ? -1 : 1,
      );
      for (const omitted of omittedCandidates) {
        dirHash.update(
          compositeKey(["omitted", omitted.identityRelPath, omitted.reason]) +
            "\n",
        );
      }
      if (traversalLimitReached) {
        dirHash.update("omitted:directory_traversal_limit\n");
      }
      if (hasUnknownCoverage) {
        dirHash.update("coverage:unknown\n");
      }

      dirSha256 =
        admittedCandidates.length === 0 &&
        manifestSha256 === null &&
        omittedCandidates.length === 0 &&
        !traversalLimitReached &&
        !hasUnknownCoverage
          ? sha256Hex(Buffer.alloc(0))
          : dirHash.digest("hex");

      const requested = input.filter_phase.toLowerCase();
      const discoveredModules: DiscoveredUefiModule[] = [];

      for (const cand of admittedCandidates) {
        const isCombinedPeimDriver =
          cand.typeName?.toLowerCase() === "combined-peim-driver";
        const isCombinedSmmDxe =
          cand.typeName?.toLowerCase() === "combined-smm-dxe";
        const matchesPhase =
          requested === "all" ||
          cand.phase.toLowerCase() === requested ||
          (requested === "dxe" && (isCombinedPeimDriver || isCombinedSmmDxe)) ||
          (requested === "pei" && isCombinedPeimDriver) ||
          (requested === "smm" && isCombinedSmmDxe);

        if (!matchesPhase) {
          continue;
        }

        const effectivePhase =
          requested !== "all" &&
          cand.typeName &&
          isPhaseSupportedByFfsType(requested.toUpperCase(), cand.typeName)
            ? (requested.toUpperCase() as
                | "SEC"
                | "PEI"
                | "DXE"
                | "SMM"
                | "APP"
                | "MISC")
            : cand.phase;

        const modData = moduleDataByIdentity.get(cand.identityRelPath)!;
        discoveredModules.push({
          guid: cand.guid,
          rawName: cand.rawName,
          cleanName: cand.cleanName,
          phase: effectivePhase,
          typeName: cand.typeName,
          sourceRelPath: cand.identityRelPath,
          sourcePath: cand.fullPath,
          entry: cand.entry,
          ...(modData.bytes !== undefined ? { bytes: modData.bytes } : {}),
          expectedSha256: modData.sha256,
          byteLength: cand.size,
        });
      }

      const dirCoverage: "complete" | "partial" =
        limitations.length > 0 || isCoveragePartial ? "partial" : "complete";
      const dirSourceCoverage: "complete" | "partial" | "unknown" =
        hasUnknownCoverage ? "unknown" : dirCoverage;

      const publishedExecution = await this.#stageAndPublishModules(
        request,
        dirSha256,
        discoveredModules,
        limitations,
        signal,
        checkpoint,
        "directory",
        remainingTimeMs,
        reader,
        dirCoverage,
        dirSourceCoverage,
      );
      publishedResult = publishedExecution.result as UefiDecompileResult;
      return publishedExecution;
    } catch (cause: unknown) {
      establishedError = cause;
      throw cause;
    } finally {
      const released = await this.#resources.release({
        kind: "reader",
        resource: input.path,
        reader,
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
                  sha256: dirSha256,
                },
              }
            : undefined;
        cleanupError = new ProviderCleanupError(
          UEFI_PROVIDER_IDENTITY.id,
          released.lease.cleanupResources ?? [input.path],
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

      const primaryError =
        establishedError instanceof AnalysisError
          ? establishedError
          : establishedError !== undefined
            ? classifyProviderFailure(
                establishedError,
                uefiFailureDialect(request.operation, input.path),
              )
            : undefined;

      if (signal.aborted) {
        const partialObservation =
          publishedResult !== undefined
            ? {
                kind: "uefi" as const,
                result: jsonValueSchema.parse(publishedResult),
                provenance: {
                  path: input.path,
                  sha256: dirSha256,
                },
              }
            : undefined;

        const cancellationError: AnalysisError =
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

        if (primaryError !== undefined) {
          let composedPrimary = primaryError;
          if (cleanupError !== undefined) {
            composedPrimary = analysisErrorWithCleanupDependencies(
              composedPrimary,
              cleanupError,
              "decompile_uefi_firmware",
            );
          }
          if (cancellationError instanceof AnalysisCancelledError) {
            throw analysisErrorWithCancellation(
              composedPrimary,
              cancellationError,
            );
          }
          composedPrimary.retainSecondaryFailure(cancellationError);
          throw composedPrimary;
        }

        if (cleanupError !== undefined) {
          throw analysisErrorWithCleanupDependencies(
            cancellationError,
            cleanupError,
            "decompile_uefi_firmware",
          );
        }
        throw cancellationError;
      }

      if (cleanupError !== undefined) {
        if (primaryError !== undefined) {
          throw analysisErrorWithCleanupDependencies(
            primaryError,
            cleanupError,
            "decompile_uefi_firmware",
          );
        }
        throw cleanupError;
      }
    }
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
