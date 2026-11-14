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
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withEvidenceCallerInputPath } from "../domain/evidence.js";
import { BYTE_ENTROPY_PROVIDER } from "../domain/investigationProviders.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../contracts/native/binaryDiagnosticsToolContracts.js";
import {
  contractNamed,
  deliverWithService,
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";

type BinaryDiagnosticsOperation =
  (typeof BINARY_DIAGNOSTICS_TOOL_CONTRACTS)[number]["name"];

const contract = <Name extends BinaryDiagnosticsOperation>(name: Name) =>
  contractNamed(BINARY_DIAGNOSTICS_TOOL_CONTRACTS, name);

/** Inspect operator-selected files through the same shared workflow as MCP. */
export const registerBinaryDiagnosticsCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contract("inspect_elf_notes"),
    {
      command: CLI_COMMANDS.inspectElfNotes,
      description:
        "Inspect ELF PT_NOTE and SHT_NOTE identities without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF32/ELF64 image" } },
    },
    inspectWithService(createElfNotesService, "rea-elf-notes"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_native_initializers"),
    {
      command: CLI_COMMANDS.inspectNativeInitializers,
      description:
        "List ELF and Mach-O initializer and finalizer functions without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local ELF32/ELF64, thin Mach-O or universal Mach-O image",
        },
        architecture: {
          description:
            "Slice to read from a universal Mach-O, by CPU family; when several slices share a family, arm64 (arm64 or arm64v8), arm64e (arm64e or arm64e.x1) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files",
        },
      },
    },
    inspectWithService(
      createNativeInitializersService,
      "rea-native-initializers",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_elf_unwind_ranges"),
    {
      command: CLI_COMMANDS.inspectElfUnwindRanges,
      description:
        "Inspect ELF unwind function ranges without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF32/ELF64 image" } },
    },
    inspectWithService(createElfUnwindRangesService, "rea-elf-unwind-ranges"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_apple_ips"),
    {
      command: CLI_COMMANDS.inspectAppleIps,
      description:
        "Inspect an Apple .ips crash report without executing a target",
      positionals: ["path"],
      callerPaths: ["path", "join_path"],
      fields: {
        path: { description: "Local Apple .ips crash report" },
        join_path: {
          description:
            "Optional local Mach-O executable or dSYM whose slice LC_UUID matches report images",
        },
      },
    },
    inspectWithService(createAppleIpsService, "rea-apple-ips"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_kernel_module"),
    {
      command: CLI_COMMANDS.inspectKernelModule,
      description:
        "Inspect Linux kernel module metadata without executing the module",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local ELF32/ELF64 kernel module or compressed .ko container",
        },
      },
    },
    inspectWithService(createKernelModuleService, "rea-kernel-module"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_kernel_build_config"),
    {
      command: CLI_COMMANDS.inspectKernelBuildConfig,
      description:
        "Inspect a Linux kernel image's version banner and embedded build config without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local vmlinux ELF, raw Image, x86 bzImage/zImage, or configs.ko",
        },
      },
    },
    inspectWithService(
      createKernelBuildConfigService,
      "rea-kernel-build-config",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_load_config"),
    {
      command: CLI_COMMANDS.inspectPeLoadConfig,
      description:
        "Inspect PE TLS callbacks and load configuration without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(createPeLoadConfigService, "rea-pe-load-config"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_binary_hardening"),
    {
      command: CLI_COMMANDS.inspectBinaryHardening,
      description:
        "Inspect ELF, PE, and Mach-O hardening without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF, PE, or Mach-O image" } },
    },
    inspectWithService(createBinaryHardeningService, "rea-binary-hardening"),
  );
  const entropy = createByteEntropyService();
  registerContractCommand(
    cli,
    logger,
    contract("inspect_byte_entropy"),
    {
      command: CLI_COMMANDS.inspectByteEntropy,
      description:
        "Inspect file-wide and block byte entropy without executing the file",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local file" },
        block_size: {
          description: "Power-of-two block size from 256 to 65536 bytes",
        },
        offset: { description: "Window start as a decimal file byte offset" },
        length: {
          description: "Window length in bytes; omit to extend through EOF",
        },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    inspectWithService(() => entropy, BYTE_ENTROPY_PROVIDER.id),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_certificates"),
    {
      command: CLI_COMMANDS.inspectPeCertificates,
      description:
        "Inspect PE Authenticode certificate table identities without verifying signatures",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(createPeCertificatesService, "rea-pe-certificates"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_imports"),
    {
      command: CLI_COMMANDS.inspectPeImports,
      description:
        "Inspect PE import and delay-load table identities without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(createPeImportsService, "rea-pe-imports"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_windows_shortcut"),
    {
      command: CLI_COMMANDS.inspectWindowsShortcut,
      description:
        "Inspect a Windows Shell Link (.lnk) without resolving or executing the target",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local Windows Shell Link (.lnk) file" },
      },
    },
    inspectWithService(createWindowsShortcutService, "rea-windows-shortcut"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_resources"),
    {
      command: CLI_COMMANDS.inspectPeResources,
      description:
        "Inspect PE resource identities, payload ranges, hashes and icon-group relationships",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(createPeResourcesService, "rea-pe-resources"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_devicetree"),
    {
      command: CLI_COMMANDS.inspectDevicetree,
      description: "Inspect a flattened devicetree blob without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local flattened devicetree image" },
        max_file_bytes: { description: "Maximum FDT file size in bytes" },
        max_nodes: { description: "Maximum number of device-tree nodes" },
        max_properties: {
          description: "Maximum number of device-tree properties",
        },
        max_depth: { description: "Maximum device-tree nesting depth" },
      },
    },
    deliverWithService(createDevicetreeService, "rea-devicetree"),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_native_exports"),
    {
      command: CLI_COMMANDS.inspectNativeExports,
      description:
        "Inspect a PE or ELF image's export table without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: { path: { description: "Local PE or ELF image" } },
    },
    deliverWithService(createNativeExportsService, "rea-native-exports"),
  );
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
