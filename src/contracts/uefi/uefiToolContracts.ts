import { z } from "zod";
import {
  uefiFirmwarePageViewResultSchema,
  uefiFirmwareSummaryViewResultSchema,
} from "../../domain/analysisView/summarySchemas/uefiFirmwareSummarySchema.js";
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
    .superRefine((input, context) => {
      if (input.view !== undefined && input.detail === "complete")
        context.addIssue({
          code: "custom",
          path: ["view"],
          message: "view requires summary detail",
        });
    });

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
] as const satisfies readonly ToolContract[];
