import {
  uefiInputSchemas,
  uefiResultSchemas,
} from "../../domain/uefi/uefiFirmwareAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  evidenceEffects,
  toolEffects,
  toolContractMetadata,
} from "../toolEffects.js";

/** Pure-TS UEFI firmware cartography and extraction with one owned LZMA lane. */
export const UEFI_TOOL_CONTRACTS = [
  {
    name: "inspect_uefi_firmware",
    cli: true,
    availability: "standalone",
    ...toolContractMetadata(
      "inspect_uefi_firmware",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
        writesFilesystem: true,
      }),
    ),
    kind: "firmware-provider",
    description:
      "Map PI firmware volumes, FFS files, section chains, AMD PSP directory candidates and uncovered ranges in a local flash image. Report integrity observations and coverage limits. LZMA-custom, LZMAF86, and AMD-zlib streams can contain nested volumes or section chains. Decoded offsets are relative to the stream identified by source_stream. EFI standard compression and other unsupported handlers remain explicit limitations.",
    inputSchema: uefiInputSchemas.inspect_uefi_firmware,
    outputSchema: evidenceResultOf(uefiResultSchemas.inspect_uefi_firmware),
    examples: [
      {
        title: "Inspect firmware volumes",
        input: { path: "/media/firmware/images/B550AORUSELITEV212.FIb" },
      },
    ],
  },
  {
    name: "extract_uefi_firmware",
    cli: true,
    availability: "standalone",
    ...toolContractMetadata(
      "extract_uefi_firmware",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
        writesFilesystem: true,
        idempotent: false,
      }),
    ),
    kind: "firmware-provider",
    description:
      "Extract FFS bodies and section payloads from a local UEFI image into an absent directory. A volume, file or section selection includes its descendants. Use source_stream with an offset from a decoded stream or when offsets are ambiguous. Results include SHA-256, source ranges and decode derivations; original_file_range is null for decoded bytes. Unsupported carriers are optional and decoding gaps remain visible. Pass an extracted PE32 file to open_binary for executable analysis.",
    inputSchema: uefiInputSchemas.extract_uefi_firmware,
    outputSchema: evidenceResultOf(uefiResultSchemas.extract_uefi_firmware),
    examples: [
      {
        title: "Extract firmware volumes",
        input: {
          path: "/media/firmware/images/B550AORUSELITEV212.FIb",
          output_directory: "/tmp/uefi-output",
        },
      },
    ],
  },
  {
    name: "inspect_uefi_nvram",
    cli: true,
    availability: "standalone",
    ...toolContractMetadata("inspect_uefi_nvram", evidenceEffects),
    kind: "firmware-provider",
    description:
      "Map valid AMI NVAR entries inside a local flash image, including nested factory defaults such as StdDefaults. Reports raw link displacements, attributes, inline GUIDs or GUID-table indices, data ranges and SHA-256 digests. Data-only records have no name or GUID reference. Links describe the image bytes. The parser walks physical records and reports the nesting depth and parent offset. No external tools or target execution are required.",
    inputSchema: uefiInputSchemas.inspect_uefi_nvram,
    outputSchema: evidenceResultOf(uefiResultSchemas.inspect_uefi_nvram),
    examples: [
      {
        title: "Inspect AMI NVRAM stores",
        input: { path: "/media/firmware/images/B550AORUSELITEV212.FId" },
      },
    ],
  },
  {
    name: "decompile_uefi_firmware",
    cli: true,
    availability: "standalone",
    ...toolContractMetadata(
      "decompile_uefi_firmware",
      toolEffects({
        mutatesSession: false,
        launchesProcess: true,
        writesFilesystem: true,
        idempotent: false,
      }),
    ),
    kind: "firmware-provider",
    description:
      "Decompile all PE32 and TE executable modules of a UEFI firmware image into a structured C source code tree, headers, disassemblies, and an indexed manifest organized by execution phase (SEC, PEI, DXE, SMM).",
    inputSchema: uefiInputSchemas.decompile_uefi_firmware,
    outputSchema: evidenceResultOf(uefiResultSchemas.decompile_uefi_firmware),
    examples: [
      {
        title: "Decompile full UEFI firmware image into C source code",
        input: {
          path: "/media/firmware/images/B550AORUSELITEV212.FIb",
          output_directory: "/tmp/decompiled_firmware",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
