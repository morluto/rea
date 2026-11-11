import {
  inspectDevicetreeInputSchema,
  devicetreeSchema,
} from "../../domain/firmware/devicetree.js";
import {
  devicetreeSummaryViewResultSchema,
  binaryLayoutSummaryViewResultSchema,
  nativeExportsSummaryViewResultSchema,
} from "../../domain/analysisView/analysisView.js";
import {
  inspectPeLoadConfigInputSchema,
  peLoadConfigSchema,
} from "../../domain/native/peLoadConfig.js";
import {
  binaryHardeningSchema,
  inspectBinaryHardeningInputSchema,
} from "../../domain/native/binaryHardening.js";
import { inspectByteEntropyInputSchema } from "../../domain/native/byteEntropy.js";
import { byteEntropyOutputSchema } from "../toolOutputSchemaGroups.js";
import {
  inspectRecordedCrashInputSchema,
  recordedCrashSchema,
} from "../../domain/native/recordedCrash.js";
import {
  inspectBinaryLayoutInputSchema,
  binaryLayoutSchema,
} from "../../domain/native/binaryLayout.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "../analysisDetail.js";
import {
  inspectNativeExportsInputSchema,
  nativeExportsSchema,
} from "../../domain/native/nativeExports.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
} from "../../domain/native/peResources.js";
import {
  inspectPeCertificatesInputSchema,
  peCertificatesSchema,
} from "../../domain/native/peCertificates.js";
import {
  inspectPeImportsInputSchema,
  peImportsSchema,
} from "../../domain/native/peImports.js";
import {
  inspectElfNotesInputSchema,
  elfNotesSchema,
} from "../../domain/native/elfNotes.js";
import {
  inspectNativeInitializersInputSchema,
  nativeInitializersSchema,
} from "../../domain/native/nativeInitializers.js";
import {
  inspectElfUnwindRangesInputSchema,
  elfUnwindRangesSchema,
} from "../../domain/native/elfUnwindRanges.js";
import {
  inspectAppleIpsInputSchema,
  appleIpsSchema,
} from "../../domain/native/appleIps.js";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
} from "../../domain/native/kernelModule.js";
import {
  inspectKernelBuildConfigInputSchema,
  kernelBuildConfigSchema,
} from "../../domain/native/kernelBuildConfig.js";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
} from "../../domain/native/windowsShortcut.js";

/** Caller-selected delivery of completed binary layout Evidence. */
export const inspectBinaryLayoutRequestSchema =
  inspectBinaryLayoutInputSchema.extend({ detail: analysisDetailSchema });

export const inspectNativeExportsRequestSchema =
  inspectNativeExportsInputSchema.extend({ detail: analysisDetailSchema });

/** Public byte-entropy input retains the producer schema's closed-object policy. */
export const inspectByteEntropyRequestSchema =
  inspectByteEntropyInputSchema.extend({ detail: analysisDetailSchema });

/** Offline binary diagnostics are independent of macOS process/UI providers. */
export const BINARY_DIAGNOSTICS_TOOL_CONTRACTS = [
  {
    name: "inspect_devicetree",
    ...toolContractMetadata("inspect_devicetree"),
    kind: "native-provider",
    description:
      "Inspect an explicit local flattened devicetree blob (FDT v16/v17) without execution or external tools. Returns validated header, memory reservations, full node/property tree with bounded raw hex, derived standard strings, cells and parent-sized reg tuples, aliases and selected single-cell phandle references with unresolved targets. Binding-specific arrays, overlays and runtime hardware remain unknown. Malformed structure or exhausted named budgets fails without partial success. Complete detail returns all Evidence inline; summary retains it for inspect_analysis_view kind devicetree, collections nodes, properties (requires exact path), reservations and references, with offset/limit pagination.",
    inputSchema: inspectDevicetreeInputSchema.extend({
      detail: analysisDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      devicetreeSchema,
      devicetreeSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect a firmware hardware description",
        input: { path: "/artifacts/board.dtb", detail: "summary" },
      },
    ],
  },
  {
    name: "inspect_pe_load_config",
    ...toolContractMetadata("inspect_pe_load_config"),
    kind: "native-provider",
    description:
      "Inspect PE32/PE32+ TLS callbacks and sized load configuration without executing the image. Returns callback VA/RVA/file offsets and sections, security cookie, SafeSEH (PE32), CFG flags and table pointers/counts, EH continuation and XFG fields. Flag-derived mitigation claims are labeled inferred. Absent directories are null; malformed structures and exhausted budgets fail without partial success. Reads a stable local regular file without a disassembler.",
    inputSchema: inspectPeLoadConfigInputSchema,
    outputSchema: evidenceResultOf(peLoadConfigSchema),
    examples: [
      {
        title: "Inspect PE TLS callbacks and load configuration",
        input: { path: "/artifacts/program" },
      },
    ],
  },
  {
    name: "inspect_binary_hardening",
    ...toolContractMetadata("inspect_binary_hardening"),
    kind: "native-provider",
    description:
      "Inspect static hardening declarations in a local ELF, PE or Mach-O, including every universal slice. Reports PIE/ASLR, NX, RELRO, stack-protector/FORTIFY signs, control-flow flags and stripped state with supporting header/import facts. Missing signs may be unknown, especially for static/stripped images. Signature presence does not establish validity; use inspect_signature for Mach-O hardened runtime. No target execution or exploitability claim. Malformed headers/budgets may fail; limited symbol/property-note reads retain header facts and mark affected rows unknown.",
    inputSchema: inspectBinaryHardeningInputSchema,
    outputSchema: evidenceResultOf(binaryHardeningSchema),
    examples: [
      {
        title: "Inspect binary hardening",
        input: { path: "/artifacts/program" },
      },
    ],
  },

  {
    name: "inspect_native_initializers",
    ...toolContractMetadata("inspect_native_initializers"),
    kind: "native-provider",
    description:
      "List declared initializer/finalizer functions in a local ELF32/64 or selected Mach-O slice without execution. Returns paged slots and resolved target addresses/file offsets, sections, exact symbols and resolution basis from dynamic tags, constructor sections, relocations and fixups. Unestablished slots remain unresolved, never treated as stored zero targets. Missing declarations do not prove no code runs before main.",
    inputSchema: inspectNativeInitializersInputSchema,
    outputSchema: evidenceResultOf(nativeInitializersSchema),
    examples: [
      {
        title: "List ELF or Mach-O static constructors and finalizers",
        input: { path: "/artifacts/program" },
      },
    ],
  },

  {
    name: "inspect_elf_notes",
    ...toolContractMetadata("inspect_elf_notes"),
    kind: "native-provider",
    description:
      "Inspect one explicit local ELF32/ELF64 image's PT_NOTE program headers and SHT_NOTE sections without executing it or opening a disassembler. Returns note-table file ranges, owners, types, descriptor SHA-256 and hex previews, plus GNU build-id, ABI-tag and gold-version fields, Linux CORE process, mapping, signal, and auxv notes, and Android .note.android.ident API-level and NDK version/build fields when those descriptors match. A missing table is observed absence of those declarations, not proof the image never carried notes in another container. Reads a stable regular file; malformed ELF headers, truncated notes and exhausted budgets return no partial success. Portable on supported Node hosts; no debug package or catalog is required.",
    inputSchema: inspectElfNotesInputSchema,
    outputSchema: evidenceResultOf(elfNotesSchema),
    examples: [
      {
        title: "Inspect ELF GNU build-id and ABI-tag notes",
        input: { path: "/artifacts/program" },
      },
    ],
  },
  {
    name: "inspect_elf_unwind_ranges",
    ...toolContractMetadata("inspect_elf_unwind_ranges"),
    kind: "native-provider",
    description:
      "Inspect ELF32/64 .eh_frame and .eh_frame_hdr for paged FDE function ranges, associated CIE facts, LSDA/personality pointers, symbol matches and search-table agreement. No execution or disassembler. Missing unwind declarations do not prove no functions; truncated records remain incomplete. .debug_frame is detected but not decoded, CFA instructions are not evaluated, and indirect EH pointers are not dereferenced. Malformed headers or exhausted CIE/FDE budgets fail without partial success.",
    inputSchema: inspectElfUnwindRangesInputSchema,
    outputSchema: evidenceResultOf(elfUnwindRangesSchema),
    examples: [
      {
        title: "List function ranges from ELF unwind tables",
        input: { path: "/artifacts/program" },
      },
    ],
  },
  {
    name: "inspect_apple_ips",
    ...toolContractMetadata("inspect_apple_ips"),
    kind: "native-provider",
    description:
      "Inspect a local Apple .ips crash report for process, exception/termination, thread, image and lossless register facts with deterministic classification. Crash parsing supports bug_type string 309; other types, including 288 stackshots, return no crash result. join_path derives static addresses only when image UUID and architecture match a Mach-O slice; it does not symbolicate or read dSYMs. Missing/truncated bodies fail without partial success. No target execution, atos, disassembler or Xcode required.",
    inputSchema: inspectAppleIpsInputSchema,
    outputSchema: evidenceResultOf(appleIpsSchema),
    examples: [
      {
        title: "Inspect an Apple .ips crash report",
        input: { path: "/artifacts/app.ips" },
      },
      {
        title: "Join report frames to the crashed Mach-O",
        input: {
          path: "/artifacts/app.ips",
          join_path: "/artifacts/App.app/Contents/MacOS/App",
        },
      },
    ],
  },
  {
    name: "inspect_kernel_module",
    ...toolContractMetadata("inspect_kernel_module"),
    kind: "native-provider",
    description:
      "Inspect an uncompressed local ELF32/64 ET_REL Linux kernel module for ordered .modinfo entries, symbol CRCs, module/export/init/exit section facts and appended signature ranges/digests. No execution, struct module decoding or certificate validation. Missing known sections describe this image only. gzip/xz/zstd require external decompression; extract_artifact does not decode those module containers. Malformed headers or exhausted entry budgets fail without partial success. Portable on supported Node hosts.",
    inputSchema: inspectKernelModuleInputSchema,
    outputSchema: evidenceResultOf(kernelModuleSchema),
    examples: [
      {
        title:
          "Inspect Linux kernel module license, vermagic, and dependencies",
        input: { path: "/artifacts/demo.ko" },
      },
    ],
  },
  {
    name: "inspect_kernel_build_config",
    ...toolContractMetadata("inspect_kernel_build_config"),
    kind: "native-provider",
    description:
      "Inspect a local Linux kernel image (vmlinux, raw arm64 Image, x86 bzImage/zImage or configs.ko) for the version/builder/compiler banner and embedded CONFIG_IKCONFIG. Returns config digest/count and paged, optionally exact-name-filtered CONFIG_* values. Only validated marker-framed gzip config is accepted; a literal marker is insufficient. Supported gzip bzImage payloads are searched; other compressed payloads require external decompression. Truncation is incomplete, not absence; budget exhaustion fails without partial success. No target execution or external tools.",
    inputSchema: inspectKernelBuildConfigInputSchema,
    outputSchema: evidenceResultOf(kernelBuildConfigSchema),
    examples: [
      {
        title: "Read a kernel image's version banner and embedded build config",
        input: { path: "/artifacts/vmlinux" },
      },
      {
        title: "Check one security option in an embedded kernel config",
        input: {
          path: "/artifacts/bzImage",
          name: "CONFIG_SECURITY_SELINUX",
        },
      },
    ],
  },
  {
    name: "inspect_byte_entropy",
    ...toolContractMetadata("inspect_byte_entropy"),
    kind: "native-provider",
    description:
      "Inspect Shannon byte entropy for one explicit local file offline, without execution, extraction or external tools. Returns file-wide SHA-256 and entropy, fixed-block entropy for an optional offset/length window, and adjacent high (>=7.2) and low (<=1.0) runs with exact file offsets. Block size is a power of two from 256 to 65536 (default 4096). Complete output can become very large because it includes one row per selected block, and summary detail still retains that full list. Use a shorter length or a larger block_size; the selected window is limited to 32,768 output blocks. Entropy cannot distinguish compression from encryption. Summary detail returns file entropy plus the ten longest runs; retrieve parent Evidence for the full series. The entire file is read even for a window.",
    inputSchema: inspectByteEntropyRequestSchema,
    outputSchema: byteEntropyOutputSchema,
    examples: [
      {
        title: "Profile firmware bytes before extraction",
        input: { path: "/artifacts/firmware.bin" },
      },
      {
        title: "Summarize a selected byte window",
        input: {
          path: "/artifacts/firmware.bin",
          offset: 4096,
          length: 65536,
          block_size: 4096,
          detail: "summary",
        },
      },
    ],
  },
  {
    name: "inspect_pe_certificates",
    ...toolContractMetadata("inspect_pe_certificates"),
    kind: "native-provider",
    description:
      "Inspect a local PE32/PE32+ certificate directory without executing it or verifying signatures. Returns WIN_CERTIFICATE ranges/types/digests and structurally decoded PKCS#7 signer, algorithm and X.509 identity fields when present. Missing directory does not establish globally unsigned status. Authenticode digest coverage, trust chains and timestamp validity remain unobserved. Malformed/truncated structures and unsupported PKCS#7 signed-data shapes fail without partial success. No Windows SDK or disassembler required.",
    inputSchema: inspectPeCertificatesInputSchema,
    outputSchema: evidenceResultOf(peCertificatesSchema),
    examples: [
      {
        title: "Inspect PE Authenticode certificate identities",
        input: { path: "/artifacts/application.exe" },
      },
    ],
  },
  {
    name: "inspect_pe_imports",
    ...toolContractMetadata("inspect_pe_imports"),
    kind: "native-provider",
    description:
      "Inspect local PE32/PE32+ standard and delay-load imports without execution. Returns DLL/named/ordinal imports, ILT/IAT RVAs, descriptors and a pefile-compatible standard-table import hash only when its row sequence is complete and comparable. Missing declarations do not establish no API use; loaded IAT, bound snapshots and forward resolution remain unknown. Unreadable names/thunks or missing tables yield partial coverage; malformed headers or exhausted budgets fail. No Windows SDK or disassembler required.",
    inputSchema: inspectPeImportsInputSchema,
    outputSchema: evidenceResultOf(peImportsSchema),
    examples: [
      {
        title: "Inspect PE import and delay-load identities",
        input: { path: "/artifacts/application.exe" },
      },
    ],
  },
  {
    name: "inspect_windows_shortcut",
    ...toolContractMetadata("inspect_windows_shortcut"),
    kind: "native-provider",
    description:
      "Inspect a local Windows Shell Link (.lnk) without resolving or executing its target, COM, or network access. Returns header/time/display facts, target-ID/link-info paths, arguments, working directory/icon and ExtraData observations, with raw hashes for unknown structures. Tracker and behavioral observations are derived. Malformed structures, odd Unicode lengths or exhausted budgets return typed failures or explicitly partial coverage with the failing offset. No Windows SDK required.",
    inputSchema: inspectWindowsShortcutInputSchema,
    outputSchema: evidenceResultOf(windowsShortcutSchema),
    examples: [
      {
        title: "Inspect a Windows Shell Link shortcut",
        input: { path: "/artifacts/shortcut.lnk" },
      },
    ],
  },
  {
    name: "inspect_pe_resources",
    ...toolContractMetadata("inspect_pe_resources"),
    kind: "native-provider",
    description:
      "Inspect a local PE32/PE32+ resource tree without execution: type/name/language identities, empty branches, UTF-16 names, payload RVA/file ranges/digests and static group-icon candidates. Language fallback, image decoding and actual UI loading remain unknown. Malformed/ambiguous mappings, non-identical overlaps or exhausted budgets fail without partial success. No Windows SDK or disassembler required.",
    inputSchema: inspectPeResourcesInputSchema,
    outputSchema: evidenceResultOf(peResourcesSchema),
    examples: [
      {
        title: "Inspect PE resource identities and icon relationships",
        input: { path: "/artifacts/application.exe" },
      },
    ],
  },
  {
    name: "inspect_native_exports",
    ...toolContractMetadata("inspect_native_exports"),
    kind: "native-provider",
    description:
      "Inspect PE/ELF exports without execution or an analysis engine; use inspect_macho for Mach-O. Returns named/ordinal/forwarded PE exports or defined ELF dynamic symbols with binding/type/version, preserving aliases, hidden versions and raw-name qualifications. Unreadable entries are partial; unavailable ELF section metadata can make enumeration unsupported. An empty complete inventory means no declared exports. detail summary retains full Evidence for inspect_analysis_view kind native-exports, collection exports/issues, with exact names/indices, fields and paging; source_index is parent-scoped.",
    inputSchema: inspectNativeExportsRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      nativeExportsSchema,
      nativeExportsSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "List a native library's exports",
        input: { path: "/artifacts/native/libexample.so" },
      },
    ],
  },
  {
    name: "inspect_binary_layout",
    ...toolContractMetadata("inspect_binary_layout"),
    kind: "native-provider",
    description:
      "Inspect static ELF section/segment, symbol, relocation, linkage and mitigation facts with artifact SHA-256 Evidence, without launching the image. Linux x64 requires caller-supplied pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2; supports ELF64 x86-64/little-endian AArch64 and ELF32 i386/little-endian ARM/little- or big-endian MIPS. Unicorn may emulate PLT instructions for derived maps. Runtime addresses/paths and complete relocation/GOT/PLT discovery remain unknown; RELR per-word locations/addends can be unknown. detail summary retains full Evidence for layout section/symbol/mitigation/linkage views. pwntools_timeout_ms bounds each command independently of producer_limits and inherited OS limits. Unsupported, malformed or oversized inputs fail without partial success.",
    inputSchema: inspectBinaryLayoutRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      binaryLayoutSchema,
      binaryLayoutSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect ELF linked and file layout",
        input: { path: "/artifacts/application.elf" },
      },
      {
        title: "Retain the complete layout and return its summary view",
        input: { path: "/artifacts/application.elf", detail: "summary" },
      },
    ],
  },
  {
    name: "inspect_recorded_crash",
    ...toolContractMetadata("inspect_recorded_crash"),
    kind: "native-provider",
    description:
      "Inspect a saved Linux ELF64 little-endian amd64/AArch64 core without launching its target or attaching to a live PID. Returns recorded segments, raw notes/ranges, thread registers and SIGINFO as digest-bound Evidence. Historical PIDs do not establish current identity; note coverage and signal/thread joins remain unknown. Optional caller-configured GDB/pwndbg adds core-only mapping candidates from the same snapshot; zero flags mean unknown permissions. Linux x64 requires the documented pwntools profile, with optional pwndbg 2026.09.15. No implicit executable/library pairing, command language or installation. pwntools_timeout_ms and producer_limits control independent per-command budgets; malformed or oversized input fails without partial success.",
    inputSchema: inspectRecordedCrashInputSchema,
    outputSchema: evidenceResultOf(recordedCrashSchema),
    examples: [
      {
        title: "Inspect recorded registers and signal evidence",
        input: { path: "/artifacts/crash.core" },
      },
      {
        title: "Add core-only debugger mapping candidates",
        input: {
          path: "/artifacts/crash.core",
          include_debugger_context: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
