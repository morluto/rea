import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { inspectDevicetreeInputSchema } from "../domain/firmware/devicetree.js";
import { inspectPeLoadConfigInputSchema } from "../domain/native/peLoadConfig.js";
import { inspectBinaryHardeningInputSchema } from "../domain/native/binaryHardening.js";
import { inspectByteEntropyInputSchema } from "../domain/native/byteEntropy.js";
import { z } from "incur";
import { cliDecimalField } from "./options.js";
import { producerLimitsOption } from "./producerLimitsOption.js";
import { pwntoolsProducerLimitsSchema } from "../domain/native/pwntoolsResourceLimits.js";
import {
  createByteEntropyService,
  createRecordedCrashService,
  createBinaryLayoutService,
  createElfNotesService,
  createNativeInitializersService,
  createElfUnwindRangesService,
  createAppleIpsService,
  createDevicetreeService,
  createKernelModuleService,
  createKernelBuildConfigService,
  createPeLoadConfigService,
  createBinaryHardeningService,
  createPeResourcesService,
  createPeCertificatesService,
  createPeImportsService,
  createWindowsShortcutService,
  createNativeExportsService,
} from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectBinaryLayoutInputSchema } from "../domain/native/binaryLayout.js";
import { inspectRecordedCrashInputSchema } from "../domain/native/recordedCrash.js";
import { inspectPeResourcesInputSchema } from "../domain/native/peResources.js";
import { inspectPeCertificatesInputSchema } from "../domain/native/peCertificates.js";
import { inspectPeImportsInputSchema } from "../domain/native/peImports.js";
import { inspectWindowsShortcutInputSchema } from "../domain/native/windowsShortcut.js";
import { inspectNativeExportsInputSchema } from "../domain/native/nativeExports.js";
import { inspectElfNotesInputSchema } from "../domain/native/elfNotes.js";
import { inspectNativeInitializersInputSchema } from "../domain/native/nativeInitializers.js";
import { machoSliceArchitectureSchema } from "../domain/apple/machoTargetSelection.js";
import { inspectElfUnwindRangesInputSchema } from "../domain/native/elfUnwindRanges.js";
import { inspectAppleIpsInputSchema } from "../domain/native/appleIps.js";
import { inspectKernelModuleInputSchema } from "../domain/native/kernelModule.js";
import { inspectKernelBuildConfigInputSchema } from "../domain/native/kernelBuildConfig.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { withEvidenceCallerInputPath } from "../domain/evidence.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";

/** Inspect operator-selected files through the same shared workflow as MCP. */
export const registerBinaryDiagnosticsCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.inspectElfNotes, {
    description:
      "Inspect ELF PT_NOTE and SHT_NOTE identities without executing the image",
    args: z.object({
      path: localPathStringSchema.describe("Local ELF32/ELF64 image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectElfNotesInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(inspectElfNotesInputSchema.shape.max_entries),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const elf = createElfNotesService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectElfNotes,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                elf.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              elf,
              "rea-elf-notes",
              "inspect_elf_notes",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectNativeInitializers, {
    description:
      "List ELF and Mach-O initializer and finalizer functions without executing the image",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local ELF32/ELF64, thin Mach-O or universal Mach-O image",
      ),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectNativeInitializersInputSchema.shape.max_file_bytes,
      ),
      offset: cliDecimalField(
        inspectNativeInitializersInputSchema.shape.offset,
      ),
      limit: cliDecimalField(inspectNativeInitializersInputSchema.shape.limit),
      architecture: machoSliceArchitectureSchema
        .optional()
        .describe(
          "CPU family of the slice to read from a universal Mach-O; required for universal files",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const initializers = createNativeInitializersService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectNativeInitializers,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                initializers.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    offset: options.offset,
                    limit: options.limit,
                    ...(options.architecture === undefined
                      ? {}
                      : { architecture: options.architecture }),
                  },
                  { signal },
                ),
              initializers,
              "rea-native-initializers",
              "inspect_native_initializers",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });

  cli.command(CLI_COMMANDS.inspectElfUnwindRanges, {
    description:
      "Inspect ELF unwind function ranges without executing the image",
    args: z.object({
      path: localPathStringSchema.describe("Local ELF32/ELF64 image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectElfUnwindRangesInputSchema.shape.max_file_bytes,
      ),
      maxRanges: cliDecimalField(
        inspectElfUnwindRangesInputSchema.shape.max_ranges,
      ),
      offset: cliDecimalField(inspectElfUnwindRangesInputSchema.shape.offset),
      limit: cliDecimalField(inspectElfUnwindRangesInputSchema.shape.limit),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const unwind = createElfUnwindRangesService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectElfUnwindRanges,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                unwind.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_ranges: options.maxRanges,
                    offset: options.offset,
                    limit: options.limit,
                  },
                  { signal },
                ),
              unwind,
              "rea-elf-unwind-ranges",
              "inspect_elf_unwind_ranges",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectAppleIps, {
    description:
      "Inspect an Apple .ips crash report without executing a target",
    args: z.object({
      path: localPathStringSchema.describe("Local Apple .ips crash report"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectAppleIpsInputSchema.shape.max_file_bytes,
      ),
      maxThreads: cliDecimalField(inspectAppleIpsInputSchema.shape.max_threads),
      maxFrames: cliDecimalField(inspectAppleIpsInputSchema.shape.max_frames),
      maxImages: cliDecimalField(inspectAppleIpsInputSchema.shape.max_images),
      maxRegisters: cliDecimalField(
        inspectAppleIpsInputSchema.shape.max_registers,
      ),
      maxIntegerTextBytes: cliDecimalField(
        inspectAppleIpsInputSchema.shape.max_integer_text_bytes,
      ),
      joinPath: z
        .string()
        .optional()
        .describe(
          "Optional local Mach-O executable or dSYM whose slice LC_UUID matches report images",
        ),
      maxJoinBytes: cliDecimalField(
        inspectAppleIpsInputSchema.shape.max_join_bytes,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const ips = createAppleIpsService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectAppleIps,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                ips.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_threads: options.maxThreads,
                    max_frames: options.maxFrames,
                    max_images: options.maxImages,
                    max_registers: options.maxRegisters,
                    max_integer_text_bytes: options.maxIntegerTextBytes,
                    ...(options.joinPath === undefined
                      ? {}
                      : { join_path: absoluteCallerPath(options.joinPath) }),
                    max_join_bytes: options.maxJoinBytes,
                  },
                  { signal },
                ),
              ips,
              "rea-apple-ips",
              "inspect_apple_ips",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectKernelModule, {
    description:
      "Inspect Linux kernel module metadata without executing the module",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local ELF32/ELF64 kernel module or compressed .ko container",
      ),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectKernelModuleInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(
        inspectKernelModuleInputSchema.shape.max_entries,
      ),
      maxModinfoKeyBytes: cliDecimalField(
        inspectKernelModuleInputSchema.shape.max_modinfo_key_bytes,
      ),
      maxModinfoValueBytes: cliDecimalField(
        inspectKernelModuleInputSchema.shape.max_modinfo_value_bytes,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const kernelModule = createKernelModuleService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectKernelModule,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                kernelModule.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                    max_modinfo_key_bytes: options.maxModinfoKeyBytes,
                    max_modinfo_value_bytes: options.maxModinfoValueBytes,
                  },
                  { signal },
                ),
              kernelModule,
              "rea-kernel-module",
              "inspect_kernel_module",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectKernelBuildConfig, {
    description:
      "Inspect a Linux kernel image's version banner and embedded build config without executing it",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local vmlinux ELF, raw Image, x86 bzImage/zImage, or configs.ko",
      ),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectKernelBuildConfigInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(
        inspectKernelBuildConfigInputSchema.shape.max_entries,
      ),
      maxConfigBytes: cliDecimalField(
        inspectKernelBuildConfigInputSchema.shape.max_config_bytes,
      ),
      maxPayloadBytes: cliDecimalField(
        inspectKernelBuildConfigInputSchema.shape.max_payload_bytes,
      ),
      offset: cliDecimalField(inspectKernelBuildConfigInputSchema.shape.offset),
      limit: cliDecimalField(inspectKernelBuildConfigInputSchema.shape.limit),
      name: inspectKernelBuildConfigInputSchema.shape.name,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const kernelBuildConfig = createKernelBuildConfigService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectKernelBuildConfig,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                kernelBuildConfig.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                    max_config_bytes: options.maxConfigBytes,
                    max_payload_bytes: options.maxPayloadBytes,
                    offset: options.offset,
                    limit: options.limit,
                    ...(options.name === undefined
                      ? {}
                      : { name: options.name }),
                  },
                  { signal },
                ),
              kernelBuildConfig,
              "rea-kernel-build-config",
              "inspect_kernel_build_config",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectPeLoadConfig, {
    description:
      "Inspect PE TLS callbacks and load configuration without executing the image",
    args: z.object({
      path: localPathStringSchema.describe("Local PE32/PE32+ image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectPeLoadConfigInputSchema.shape.max_file_bytes,
      ),
      maxCallbacks: cliDecimalField(
        inspectPeLoadConfigInputSchema.shape.max_callbacks,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const elf = createPeLoadConfigService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPeLoadConfig,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                elf.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_callbacks: options.maxCallbacks,
                  },
                  { signal },
                ),
              elf,
              "rea-pe-load-config",
              "inspect_pe_load_config",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectBinaryHardening, {
    description:
      "Inspect ELF, PE, and Mach-O hardening without executing the image",
    args: z.object({
      path: localPathStringSchema.describe("Local ELF, PE, or Mach-O image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectBinaryHardeningInputSchema.shape.max_file_bytes,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const hardening = createBinaryHardeningService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectBinaryHardening,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                hardening.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                  },
                  { signal },
                ),
              hardening,
              "rea-binary-hardening",
              "inspect_binary_hardening",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  const entropy = createByteEntropyService();
  cli.command(CLI_COMMANDS.inspectByteEntropy, {
    description:
      "Inspect file-wide and block byte entropy without executing the file",
    args: z.object({ path: localPathStringSchema.describe("Local file") }),
    options: z.object({
      // Decimal tokens only: numeric coercion would read "" as 0 and accept
      // "0x10" or "1e2".
      blockSize: cliDecimalField(
        inspectByteEntropyInputSchema.shape.block_size,
      ).describe("Power-of-two block size from 256 to 65536 bytes"),
      offset: cliDecimalField(
        inspectByteEntropyInputSchema.shape.offset,
      ).describe("Window start as a decimal file byte offset"),
      length: cliDecimalField(
        inspectByteEntropyInputSchema.shape.length,
      ).describe("Window length in bytes; omit to extend through EOF"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectByteEntropy, async () => {
          return await finishCliEvidenceCommand(
            args.path,
            () =>
              entropy.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  block_size: options.blockSize,
                  offset: options.offset,
                  length: options.length,
                },
                { signal },
              ),
            entropy,
            "rea-byte-entropy",
            "inspect_byte_entropy",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectPeCertificates, {
    description:
      "Inspect PE Authenticode certificate table identities without verifying signatures",
    args: z.object({
      path: localPathStringSchema.describe("Local PE32/PE32+ image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectPeCertificatesInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(
        inspectPeCertificatesInputSchema.shape.max_entries,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const pe = createPeCertificatesService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPeCertificates,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                pe.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              pe,
              "rea-pe-certificates",
              "inspect_pe_certificates",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectPeImports, {
    description:
      "Inspect PE import and delay-load table identities without executing the image",
    args: z.object({
      path: localPathStringSchema.describe("Local PE32/PE32+ image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectPeImportsInputSchema.shape.max_file_bytes,
      ),
      maxDlls: cliDecimalField(inspectPeImportsInputSchema.shape.max_dlls),
      maxFunctions: cliDecimalField(
        inspectPeImportsInputSchema.shape.max_functions,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const pe = createPeImportsService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPeImports,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                pe.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_dlls: options.maxDlls,
                    max_functions: options.maxFunctions,
                  },
                  { signal },
                ),
              pe,
              "rea-pe-imports",
              "inspect_pe_imports",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectWindowsShortcut, {
    description:
      "Inspect a Windows Shell Link (.lnk) without resolving or executing the target",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local Windows Shell Link (.lnk) file",
      ),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectWindowsShortcutInputSchema.shape.max_file_bytes,
      ),
      maxIdListItems: cliDecimalField(
        inspectWindowsShortcutInputSchema.shape.max_id_list_items,
      ),
      maxExtraDataBlocks: cliDecimalField(
        inspectWindowsShortcutInputSchema.shape.max_extra_data_blocks,
      ),
      maxStringBytes: cliDecimalField(
        inspectWindowsShortcutInputSchema.shape.max_string_bytes,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const shortcut = createWindowsShortcutService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectWindowsShortcut,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                shortcut.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_id_list_items: options.maxIdListItems,
                    max_extra_data_blocks: options.maxExtraDataBlocks,
                    max_string_bytes: options.maxStringBytes,
                  },
                  { signal },
                ),
              shortcut,
              "rea-windows-shortcut",
              "inspect_windows_shortcut",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectPeResources, {
    description:
      "Inspect PE resource identities, payload ranges, hashes and icon-group relationships",
    args: z.object({
      path: localPathStringSchema.describe("Local PE32/PE32+ image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectPeResourcesInputSchema.shape.max_file_bytes,
      ),
      maxEntries: cliDecimalField(
        inspectPeResourcesInputSchema.shape.max_entries,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const pe = createPeResourcesService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPeResources,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                pe.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_entries: options.maxEntries,
                  },
                  { signal },
                ),
              pe,
              "rea-pe-resources",
              "inspect_pe_resources",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectDevicetree, {
    description: "Inspect a flattened devicetree blob without executing it",
    args: z.object({
      path: localPathStringSchema.describe("Local flattened devicetree image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectDevicetreeInputSchema.shape.max_file_bytes,
      ).describe("Maximum FDT file size in bytes"),
      maxNodes: cliDecimalField(
        inspectDevicetreeInputSchema.shape.max_nodes,
      ).describe("Maximum number of device-tree nodes"),
      maxProperties: cliDecimalField(
        inspectDevicetreeInputSchema.shape.max_properties,
      ).describe("Maximum number of device-tree properties"),
      maxDepth: cliDecimalField(
        inspectDevicetreeInputSchema.shape.max_depth,
      ).describe("Maximum device-tree nesting depth"),
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const devicetree = createDevicetreeService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectDevicetree,
          async () =>
            deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                devicetree.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_nodes: options.maxNodes,
                    max_properties: options.maxProperties,
                    max_depth: options.maxDepth,
                  },
                  { signal },
                ),
              service: devicetree,
              providerId: "rea-devicetree",
              operation: "inspect_devicetree",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            }),
        );
      }),
  });
  cli.command(CLI_COMMANDS.inspectNativeExports, {
    description:
      "Inspect a PE or ELF image's export table without executing it",
    args: z.object({
      path: localPathStringSchema.describe("Local PE or ELF image"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectNativeExportsInputSchema.shape.max_file_bytes,
      ),
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const exports = createNativeExportsService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectNativeExports,
          async () =>
            deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                exports.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                  },
                  { signal },
                ),
              service: exports,
              providerId: "rea-native-exports",
              operation: "inspect_native_exports",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            }),
        );
      }),
  });
  const service = createBinaryLayoutService(environment);
  cli.command(CLI_COMMANDS.inspectBinaryLayout, {
    description:
      "Inspect binary file/linked layout without executing the selected object",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local ELF binary or relocatable object",
      ),
    }),
    options: z.object({
      producerLimits: producerLimitsOption(pwntoolsProducerLimitsSchema),
      pwntoolsTimeoutMs: cliDecimalField(
        inspectBinaryLayoutInputSchema.shape.pwntools_timeout_ms,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectBinaryLayout, async () => {
          const result = await service.inspectAndClose(
            {
              path: absoluteCallerPath(args.path),
              ...(options.producerLimits === undefined
                ? {}
                : { producer_limits: options.producerLimits }),
              ...(options.pwntoolsTimeoutMs === undefined
                ? {}
                : { pwntools_timeout_ms: options.pwntoolsTimeoutMs }),
            },
            { signal },
          );
          return result.ok
            ? withEvidenceCallerInputPath(result.value, args.path)
            : projectAnalysisError(result.error);
        }),
      ),
  });
  const recorded = createRecordedCrashService(environment);
  cli.command(CLI_COMMANDS.inspectRecordedCrash, {
    description:
      "Inspect supplied core registers/signals and optional debugger mapping evidence",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local Linux ELF64 amd64 or AArch64 little-endian core",
      ),
    }),
    options: z.object({
      producerLimits: producerLimitsOption(pwntoolsProducerLimitsSchema),
      debuggerContext: z
        .boolean()
        .default(false)
        .describe("Add BYO core-only GDB/pwndbg mapping candidates"),
      pwntoolsTimeoutMs: cliDecimalField(
        inspectRecordedCrashInputSchema.shape.pwntools_timeout_ms,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectRecordedCrash, async () => {
          const result = await recorded.inspectAndClose(
            {
              path: absoluteCallerPath(args.path),
              include_debugger_context: options.debuggerContext,
              ...(options.producerLimits === undefined
                ? {}
                : { producer_limits: options.producerLimits }),
              ...(options.pwntoolsTimeoutMs === undefined
                ? {}
                : { pwntools_timeout_ms: options.pwntoolsTimeoutMs }),
            },
            { signal },
          );
          return result.ok
            ? withEvidenceCallerInputPath(result.value, args.path)
            : projectAnalysisError(result.error);
        }),
      ),
  });
};
