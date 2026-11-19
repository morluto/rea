import {
  uefiInputSchemas,
  uefiResultSchemas,
} from "../../domain/uefi/uefiFirmwareAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Pure-TS UEFI firmware cartography and extraction with one owned LZMA lane. */
export const UEFI_TOOL_CONTRACTS = [
  {
    name: "inspect_uefi_firmware",
    ...toolContractMetadata("inspect_uefi_firmware"),
    kind: "firmware-provider",
    description:
      "Map PI firmware volumes, FFS files, section chains, AMD PSP directory candidates and uncovered ranges in a local flash image. Report integrity observations and coverage limits. LZMA-custom and AMD-zlib streams can contain nested volumes or section chains. Decoded offsets are relative to the stream identified by source_stream. LZMAF86, EFI standard compression and other unsupported handlers remain explicit limitations.",
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
    ...toolContractMetadata("extract_uefi_firmware"),
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
    ...toolContractMetadata("inspect_uefi_nvram"),
    kind: "firmware-provider",
    description:
      "Map AMI NVRAM variable stores (factory-default 'StdDefaults' and peer stores) inside a local flash image with the pure-TypeScript rea-uefi parser: scan the raw image for NVAR entry chains, validate the strong attribute/name signature, and recurse into the nested chain that a container such as StdDefaults carries so the individual setup variables surface as depth/`parent_offset` rows. Reports each variable's attributes, state, data range and SHA-256 plus trailing padding. Nothing is executed and no external tool or decompression lane is required. Variables are name-only in this proprietary layout; namespace GUIDs live in the IFR varstore, not here.",
    inputSchema: uefiInputSchemas.inspect_uefi_nvram,
    outputSchema: evidenceResultOf(uefiResultSchemas.inspect_uefi_nvram),
    examples: [
      {
        title: "Inspect AMI NVRAM stores",
        input: { path: "/media/firmware/images/B550AORUSELITEV212.FId" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
