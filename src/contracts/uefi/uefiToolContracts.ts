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
      "Map the UEFI firmware volumes, FFS files and section chains of a local flash image with the pure-TypeScript rea-uefi parser: incremental SHA-256, aligned _FVH discovery with plausibility checks, volume-relative FFS walking, guided-section compression classification, conservative PSP-directory probing and classification of leftover regions. Reports one flat volume inventory with parent linkage, integrity notes and explicit limitations; nothing is executed and no external tool is required. LZMA-custom and LZMAF86 payloads decode through one bounded owned node worker (pinned lzma-purejs); other compression GUIDs stay recognized-with-gaps and keep their limits explicit.",
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
      "Extract selected UEFI firmware bytes with the rea-uefi parser into an absent output directory: whole-image, one firmware volume, one FFS file or one section. Publishes section payloads, uncompressed file bodies and decoded LZMA-custom streams with their original image ranges, parent logical paths, derivations and SHA-256 digests, while recognized-but-undecodable payloads stay explicit extraction_gaps rows (carriers published only when requested). Staging uses SafeOutputTree semantics: exclusive creation, no executable bits, digest-verified writes, commit or rollback; budgets cap output bytes and files. Select a published PE32 file with open_binary for deep-provider analysis; runtime addresses stay null because they are not statically proven.",
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
