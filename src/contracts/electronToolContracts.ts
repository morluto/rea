import type { ToolContract } from "./toolContracts.js";
import { evidenceEnvelopeSchema } from "../domain/evidence.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";

const listOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: electronTargetListSchema });
const inspectionOutputSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: electronPageInspectionSchema });

const endpoint = "http://127.0.0.1:9223";
const root = "/Applications/Example.app/Contents/Resources";

/** Root-confined Electron file-page discovery and inspection contracts. */
export const ELECTRON_TOOL_CONTRACTS = [
  {
    name: "list_electron_targets",
    description:
      "List Electron file:// page targets from an approved user-owned loopback CDP endpoint. Every path is canonicalized and must remain contained by an approved filesystem root, including after symlink resolution.",
    kind: "electron-provider",
    inputSchema: listElectronTargetsInputSchema,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    examples: [
      {
        title: "List approved Electron file pages",
        input: {
          cdp_endpoint: endpoint,
          allowed_file_roots: [root],
          approved: true,
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "inspect_electron_page",
    description:
      "Passively inspect one approved Electron file page through CDP. Returns root-confined frames, DOM structure, resource paths, and scripts without evaluating renderer JavaScript or invoking Electron APIs; script contents require separate approval.",
    kind: "electron-provider",
    inputSchema: inspectElectronPageInputSchema,
    outputSchema: inspectionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    examples: [
      {
        title: "Inspect an approved Electron page",
        input: {
          cdp_endpoint: endpoint,
          allowed_file_roots: [root],
          target_id: "TARGET_ID_FROM_LIST_ELECTRON_TARGETS",
          approved: true,
          observation_ms: 100,
          include_script_sources: false,
          source_capture_approved: false,
          limits: {
            max_frames: 200,
            max_dom_nodes: 2_000,
            max_scripts: 500,
            max_resources: 2_000,
            max_script_source_bytes: 1_048_576,
            max_total_script_source_bytes: 4_194_304,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
