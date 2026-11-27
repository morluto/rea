import { z } from "zod";
import {
  uefiFirmwarePageViewResultSchema,
  uefiFirmwareSummaryViewResultSchema,
} from "../../domain/analysisView/summarySchemas/uefiFirmwareSummarySchema.js";
import {
  uefiExtractionPageViewResultSchema,
  uefiExtractionSummaryViewResultSchema,
} from "../../domain/analysisView/summarySchemas/uefiExtractionSummarySchema.js";
import { uefiExtractionViewRequestSchema } from "../../domain/analysisView/uefiExtractionView.js";
import { uefiFirmwareViewRequestSchema } from "../../domain/analysisView/uefiFirmwareView.js";
import {
  uefiInputSchemas,
  uefiResultSchemas,
} from "../../domain/uefi/uefiFirmwareAnalysis.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  evidenceEffects,
  toolEffects,
  toolContractMetadata,
} from "../toolEffects.js";

/** A view selects a page of retained Evidence, so complete delivery has none. */
const requireSummaryForView = (
  input: { readonly detail: "complete" | "summary"; readonly view?: unknown },
  context: z.RefinementCtx,
): void => {
  if (input.view !== undefined && input.detail === "complete")
    context.addIssue({
      code: "custom",
      path: ["view"],
      message: "view requires summary detail",
    });
};

/** Delivery is an adapter choice; the parser receives only its own scan input. */
export const inspectUefiFirmwareRequestSchema =
  uefiInputSchemas.inspect_uefi_firmware
    .extend({
      detail: z
        .enum(["complete", "summary"])
        .default("summary")
        .describe(
          "summary (default) retains the complete map in this session and returns counts, or the selected view; complete returns every volume, file and section inline and can exceed client result limits.",
        ),
      view: uefiFirmwareViewRequestSchema
        .optional()
        .describe(
          'Optional first page with summary detail, for example {kind:"uefi-firmware",collection:"files",ui_names:["PlatformDxe"]}',
        ),
    })
    .superRefine(requireSummaryForView);

/** Delivery is an adapter choice; the extractor receives only its own input. */
export const extractUefiFirmwareRequestSchema =
  uefiInputSchemas.extract_uefi_firmware
    .extend({
      detail: z
        .enum(["complete", "summary"])
        .default("summary")
        .describe(
          "summary (default) retains the complete manifest in this session and returns counts with the first published files, or the selected view; complete lists every published file inline and can exceed client result limits for a whole image.",
        ),
      view: uefiExtractionViewRequestSchema
        .optional()
        .describe(
          'Optional first page with summary detail, for example {kind:"uefi-extraction",collection:"files",media_types:["application/vnd.microsoft.portable-executable"],order:"size-desc",limit:3}',
        ),
    })
    .superRefine(requireSummaryForView);

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
      "Map PI firmware volumes, FFS files, section chains, AMD PSP directory candidates and uncovered ranges in a local flash image. Report integrity observations and coverage limits. LZMA-custom, LZMAF86, and AMD-zlib streams can contain nested volumes or section chains. Decoded offsets are relative to the stream identified by source_stream. EFI standard compression and other unsupported handlers remain explicit limitations. Default summary retains the complete map and returns volume/file/section counts and type tallies. view kind uefi-firmware selects volumes, files (exact guids, ui_names, type_names, volume_path), sections (exact file_path, type_names), unknown-regions, integrity, psp-tables or psp-candidates with offset/limit; pass it here for the first page, then use inspect_analysis_view with normalized_result.parent_evidence_id. File rows list up to 32 sections with type, offset, length, SHA-256, source_stream and truncated/malformed flags, plus section_count; extract_uefi_firmware targets those offsets. detail complete returns every record inline.",
    inputSchema: inspectUefiFirmwareRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      uefiResultSchemas.inspect_uefi_firmware,
      z.union([
        uefiFirmwareSummaryViewResultSchema,
        uefiFirmwarePageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Summarize firmware volumes",
        input: { path: "/media/firmware/images/B550AORUSELITEV212.FIb" },
      },
      {
        title: "Find a driver by its user-interface name",
        input: {
          path: "/media/firmware/images/B550AORUSELITEV212.FIb",
          view: {
            kind: "uefi-firmware",
            collection: "files",
            ui_names: ["PlatformDxe"],
          },
        },
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
      "Extract FFS bodies and section payloads from a local UEFI image into an absent directory. A volume, file or section selection includes its descendants. Use source_stream with an offset from a decoded stream or when offsets are ambiguous. Results include SHA-256, source ranges, the owning FFS file (GUID, UI name, type) and decode derivations; original_file_range is null for decoded bytes. Unsupported carriers are optional and decoding gaps remain visible. Default summary retains the complete manifest and returns counts, source/media-type/gap tallies and the first 8 published files. view kind uefi-extraction pages files (exact media_types, sources, ffs_guids, ffs_ui_names, ffs_type_names; order source or size-desc), derivations or gaps; pass it here for the first page, then use inspect_analysis_view with normalized_result.parent_evidence_id, because repeating the extraction needs another absent directory. detail complete lists every file inline. Pass an extracted PE32 file to open_binary for executable analysis.",
    inputSchema: extractUefiFirmwareRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      uefiResultSchemas.extract_uefi_firmware,
      z.union([
        uefiExtractionSummaryViewResultSchema,
        uefiExtractionPageViewResultSchema,
      ]),
    ),
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
      "Map AMI NVAR chains and TianoCore EDK2 / OVMF VARIABLE_STORE_HEADER regions inside a local flash image. AMI results stay under stores (nested StdDefaults, raw link displacements, 8-bit attributes, GUID index or inline GUID). EDK2 results are under edk2_stores (gEfiVariableGuid / gEfiAuthenticatedVariableGuid, 32-bit EFI Attributes, State including added vs in-deleted-transition vs deleted, vendor GUID, data ranges and SHA-256). Variable bytes are never interpreted. No external tools or target execution are required.",
    inputSchema: uefiInputSchemas.inspect_uefi_nvram,
    outputSchema: evidenceResultOf(uefiResultSchemas.inspect_uefi_nvram),
    examples: [
      {
        title: "Inspect AMI NVRAM stores",
        input: { path: "/media/firmware/images/B550AORUSELITEV212.FId" },
      },
      {
        title: "Inspect EDK2 / OVMF variable store",
        input: { path: "/tmp/OVMF_VARS.fd" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
