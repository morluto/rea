import {
  firmwareInputSchemas,
  firmwareResultSchemas,
} from "../../domain/firmware/firmwareAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";
import {
  FIRMWARE_OPERATION_ENGINES,
  FIRMWARE_TOOL_REQUIREMENTS,
} from "./firmwareToolRequirements.js";

/** Explicit local firmware observations and extraction, backed by caller-supplied tools. */
export const FIRMWARE_TOOL_CONTRACTS = [
  {
    name: "inspect_firmware_regions",
    ...toolContractMetadata("inspect_firmware_regions"),
    kind: "firmware-provider",
    description: `Inspect signature candidates in a local firmware file with ${FIRMWARE_TOOL_REQUIREMENTS[FIRMWARE_OPERATION_ENGINES.inspect_firmware_regions].requirement}. Returns offsets, reported lengths, descriptions and raw confidence values. Length validation and runtime addresses remain unknown. No extraction or target execution. Linux, caller-supplied tool, util-linux prlimit and procps ps required; 128 MiB input limit, one worker. Adjust analysis_timeout_ms for the analysis wall-clock budget (default 120000); fixed per-process limits are unchanged.`,
    inputSchema: firmwareInputSchemas.inspect_firmware_regions,
    outputSchema: evidenceResultOf(
      firmwareResultSchemas.inspect_firmware_regions,
    ),
    examples: [
      {
        title: "Inspect firmware regions",
        input: { path: "/tmp/firmware.bin" },
      },
    ],
  },
  {
    name: "extract_firmware",
    ...toolContractMetadata("extract_firmware"),
    kind: "firmware-provider",
    description: `Extract selected local firmware bytes with ${FIRMWARE_TOOL_REQUIREMENTS[FIRMWARE_OPERATION_ENGINES.extract_firmware].requirement} into an absent output directory. Returns verified child paths/digests, derivations, uncovered ranges, unknown chunks and extraction_gaps with continuation_id recovery instructions. Linux, format-specific extractors, prlimit and procps ps are required. Preserves the sandbox and publishes only regular files; no mounts or extracted-code execution. Select a returned native file with open_binary for analysis. Decompressed offsets are not original-file addresses.`,
    inputSchema: firmwareInputSchemas.extract_firmware,
    outputSchema: evidenceResultOf(firmwareResultSchemas.extract_firmware),
    examples: [
      {
        title: "Extract selected firmware",
        input: {
          path: "/tmp/firmware.bin",
          output_directory: "/tmp/firmware-output",
          range: { offset: 64, length: 4096 },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
