import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/electronObservation.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../domain/javascriptApplicationAnalysis.js";
import {
  javascriptRuntimeReconciliationResultSchema,
  reconcileJavaScriptRuntimeInputSchema,
} from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "./javascriptRuntimeReconciliationExample.js";

const listOutputSchema = evidenceResultOf(electronTargetListSchema);
const inspectionOutputSchema = evidenceResultOf(electronPageInspectionSchema);
const applicationOutputSchema = evidenceResultOf(
  javascriptApplicationAnalysisResultSchema,
);
const reconciliationOutputSchema = evidenceResultOf(
  javascriptRuntimeReconciliationResultSchema,
);

const endpoint = "http://127.0.0.1:9223";
const root = "/Applications/Example.app/Contents/Resources";

/** Root-confined Electron file-page discovery and inspection contracts. */
export const ELECTRON_TOOL_CONTRACTS = [
  {
    name: "list_electron_targets",
    ...toolContractMetadata("list_electron_targets"),
    description:
      "List Electron file:// page targets from an approved user-owned loopback CDP endpoint. Every path is canonicalized and must remain contained by an approved filesystem root, including after symlink resolution.",
    kind: "electron-provider",
    inputSchema: listElectronTargetsInputSchema,
    outputSchema: listOutputSchema,
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
    ...toolContractMetadata("inspect_electron_page"),
    description:
      "Passively inspect one approved Electron file page through CDP. Returns root-confined frames, DOM structure, resource paths, and scripts without evaluating renderer JavaScript or invoking Electron APIs; script contents require separate approval.",
    kind: "electron-provider",
    inputSchema: inspectElectronPageInputSchema,
    outputSchema: inspectionOutputSchema,
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
            max_workers: 500,
            max_script_source_bytes: 1_048_576,
            max_total_script_source_bytes: 4_194_304,
          },
        },
      },
    ],
  },
  {
    name: "analyze_javascript_application",
    ...toolContractMetadata("analyze_javascript_application"),
    description:
      "Statically reconstruct one approved local ASAR or extracted JavaScript application as Evidence v2 and JavaScript Application Graph v1. Maps BrowserWindow preferences, preload and contextBridge APIs, literal and dynamic IPC, handler locations, sender-validation observations, utility processes, and requested native addon bindings without executing JavaScript; source-map contents require separate approval.",
    kind: "electron-provider",
    inputSchema: analyzeJavaScriptApplicationInputSchema,
    outputSchema: applicationOutputSchema,
    examples: [
      {
        title: "Analyze one approved local Electron application",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          format: "auto",
          approved: true,
          source_map_read_approved: false,
        },
      },
    ],
  },
  {
    name: "reconcile_javascript_runtime",
    ...toolContractMetadata("reconcile_javascript_runtime"),
    description:
      "Reconcile verified static JavaScript application graphs with existing passive web or Electron CDP Evidence. Exact captured-source digests take priority over caller-declared file/URL mappings; target, frame, script, and worker ambiguity remains explicit, and source-map authority stays separate.",
    kind: "electron-provider",
    inputSchema: reconcileJavaScriptRuntimeInputSchema,
    outputSchema: reconciliationOutputSchema,
    examples: [
      {
        title: "Reconcile one passive Electron capture",
        input: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
      },
    ],
  },
] as const satisfies readonly ToolContract[];
