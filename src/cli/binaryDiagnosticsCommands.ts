import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withEvidenceCallerInputPath } from "../domain/evidence.js";
import { BYTE_ENTROPY_PROVIDER } from "../domain/investigationProviders.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../contracts/native/binaryDiagnosticsToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  callerTargetPath,
  registerContractCommand,
} from "./contractCommand.js";
import {
  deliverWithService,
  inspectWithService,
} from "./contractCommandRunners.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";

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
      description:
        "Inspect ELF PT_NOTE and SHT_NOTE identities without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF32/ELF64 image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/elfNotes.js")
        ).createElfNotesService(),
      "rea-elf-notes",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_dwarf_units"),
    {
      description: "Inspect DWARF compile units without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local ELF, Mach-O, or PE image, or a DWARF file inside a .dSYM bundle",
        },
        architecture: {
          description:
            "CPU family of the slice to read from a universal Mach-O; required for universal files",
        },
      },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/dwarfUnits.js")
        ).createDwarfUnitsService(),
      "rea-dwarf-units",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_elf_debug_link"),
    {
      description:
        "Inspect ELF separate debug-file linkage without executing the image",
      positionals: ["path"],
      callerPaths: ["path", "candidate_path"],
      fields: {
        path: { description: "Local ELF32/ELF64 image" },
        candidate_path: {
          description: "One caller-selected debug file to verify",
        },
      },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/elfDebugLink.js")
        ).createElfDebugLinkService(),
      "rea-elf-debug-link",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_native_initializers"),
    {
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
      async () =>
        (
          await import("../composition/binaryDiagnostics/nativeInitializers.js")
        ).createNativeInitializersService(),
      "rea-native-initializers",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_elf_unwind_ranges"),
    {
      description:
        "Inspect ELF unwind function ranges without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF32/ELF64 image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/elfUnwindRanges.js")
        ).createElfUnwindRangesService(),
      "rea-elf-unwind-ranges",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_apple_ips"),
    {
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
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/appleIps.js")
        ).createAppleIpsService(),
      "rea-apple-ips",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_kernel_module"),
    {
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
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/kernelModule.js")
        ).createKernelModuleService(),
      "rea-kernel-module",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_kernel_build_config"),
    {
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
      async () =>
        (
          await import("../composition/binaryDiagnostics/kernelBuildConfig.js")
        ).createKernelBuildConfigService(),
      "rea-kernel-build-config",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_load_config"),
    {
      description:
        "Inspect PE TLS callbacks and load configuration without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/peLoadConfig.js")
        ).createPeLoadConfigService(),
      "rea-pe-load-config",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_binary_hardening"),
    {
      description:
        "Inspect ELF, PE, and Mach-O hardening without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local ELF, PE, or Mach-O image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/binaryHardening.js")
        ).createBinaryHardeningService(),
      "rea-binary-hardening",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_byte_entropy"),
    {
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
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/byteEntropy.js")
        ).createByteEntropyService(),
      BYTE_ENTROPY_PROVIDER.id,
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_certificates"),
    {
      description:
        "Inspect PE Authenticode certificate table identities without verifying signatures",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/peCertificates.js")
        ).createPeCertificatesService(),
      "rea-pe-certificates",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_imports"),
    {
      description:
        "Inspect PE import and delay-load table identities without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/peImports.js")
        ).createPeImportsService(),
      "rea-pe-imports",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_rich_header"),
    {
      description:
        "Inspect PE Rich header linker records without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/peRichHeader.js")
        ).createPeRichHeaderService(),
      "rea-pe-rich-header",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_windows_shortcut"),
    {
      description:
        "Inspect a Windows Shell Link (.lnk) without resolving or executing the target",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local Windows Shell Link (.lnk) file" },
      },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/windowsShortcut.js")
        ).createWindowsShortcutService(),
      "rea-windows-shortcut",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_pe_resources"),
    {
      description:
        "Inspect PE resource identities, payload ranges, hashes and icon-group relationships",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: { description: "Local PE32/PE32+ image" } },
    },
    inspectWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/peResources.js")
        ).createPeResourcesService(),
      "rea-pe-resources",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_devicetree"),
    {
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
    deliverWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/devicetree.js")
        ).createDevicetreeService(),
      "rea-devicetree",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_native_exports"),
    {
      description:
        "Inspect PE or ELF image's export table without executing it",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: { path: { description: "Local PE or ELF image" } },
    },
    deliverWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/nativeExports.js")
        ).createNativeExportsService(),
      "rea-native-exports",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_elf_dependencies"),
    {
      description:
        "Inspect ELF needed libraries and required symbol versions without executing the image",
      positionals: ["path"],
      callerPaths: ["path"],
      evidenceDelivery: true,
      fields: {
        path: { description: "Local ELF32/ELF64 ET_EXEC or ET_DYN image" },
      },
    },
    deliverWithService(
      async () =>
        (
          await import("../composition/binaryDiagnostics/elfDependencies.js")
        ).createElfDependenciesService(),
      "rea-elf-dependencies",
    ),
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_binary_layout"),
    {
      description:
        "Inspect ELF file/linked layout without executing the selected object; Linux x64 with caller-supplied pwntools only",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        path: { description: "Local ELF binary or relocatable object" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    async (input, context) => {
      const { createBinaryLayoutService } =
        await import("../composition/binaryDiagnostics/binaryLayout.js");
      const result = await createBinaryLayoutService(
        environment,
      ).inspectAndClose(input, {
        signal: context.signal,
      });
      return result.ok
        ? withEvidenceCallerInputPath(result.value, callerTargetPath(context))
        : projectAnalysisError(result.error);
    },
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_recorded_crash"),
    {
      description:
        "Inspect supplied core registers/signals and optional debugger mapping evidence",
      positionals: ["path"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        path: {
          description: "Local Linux ELF64 amd64 or AArch64 little-endian core",
        },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
        include_debugger_context: {
          name: "debuggerContext",
          description: "Add BYO core-only GDB/pwndbg mapping candidates",
        },
      },
    },
    async (input, context) => {
      const { createRecordedCrashService } =
        await import("../composition/binaryDiagnostics/recordedCrash.js");
      const result = await createRecordedCrashService(
        environment,
      ).inspectAndClose(input, {
        signal: context.signal,
      });
      return result.ok
        ? withEvidenceCallerInputPath(result.value, callerTargetPath(context))
        : projectAnalysisError(result.error);
    },
  );
};
