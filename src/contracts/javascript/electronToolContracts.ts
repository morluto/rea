import type { ToolContract } from "../toolContracts.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemas.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../../domain/javascript/electronObservation.js";
import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
} from "../../domain/javascript/electronActiveObservation.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../../domain/javascript/javascriptApplicationAnalysis.js";
import {
  javascriptRuntimeReconciliationResultSchema,
  reconcileJavaScriptRuntimeInputSchema,
} from "../../domain/javascript/javascriptRuntimeReconciliationSchemas.js";
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
const activeExample = {
  executable_path: "/Applications/Electron.app/Contents/MacOS/Electron",
  application_path: "/Applications/Example.app/Contents/Resources/main.js",
  args: [],
  actions: [{ step_id: "exercise-ipc", kind: "click", selector: "#run" }],
};

/** Endpoint-scoped Electron file-page discovery and inspection contracts. */
export const ELECTRON_TOOL_CONTRACTS = [
  {
    name: "list_electron_targets",
    ...toolContractMetadata("list_electron_targets"),
    description:
      "List every Electron file:// page target from a selected loopback CDP endpoint. Local file paths are canonicalized after symlink resolution. Selecting an endpoint exposes every eligible target and its local path metadata.",
    kind: "electron-provider",
    inputSchema: listElectronTargetsInputSchema,
    outputSchema: listOutputSchema,
    examples: [
      {
        title: "List Electron file pages",
        input: {
          cdp_endpoint: endpoint,
        },
      },
    ],
  },
  {
    name: "inspect_electron_page",
    ...toolContractMetadata("inspect_electron_page"),
    description:
      "Passively inspect one Electron file page by supplying its loopback CDP endpoint and target ID. The provider rechecks that the target currently exists at that endpoint and is a local file page. Returns frames, DOM structure, resource paths, and scripts without evaluating renderer JavaScript or invoking Electron APIs. The selected endpoint exposes every local file page and its metadata to this tool.",
    kind: "electron-provider",
    inputSchema: inspectElectronPageInputSchema,
    outputSchema: inspectionOutputSchema,
    examples: [
      {
        title: "Inspect an Electron page",
        input: {
          cdp_endpoint: endpoint,
          target_id: "TARGET_ID_FROM_LIST_ELECTRON_TARGETS",
        },
      },
    ],
  },
  {
    name: "analyze_javascript_application",
    ...toolContractMetadata("analyze_javascript_application"),
    description:
      "Reconstruct one local ASAR or extracted JavaScript application as an inline application graph without executing it. Returns all recovered graph nodes, edges, semantic relations, limitations, and coverage.",
    kind: "electron-provider",
    inputSchema: analyzeJavaScriptApplicationInputSchema,
    outputSchema: applicationOutputSchema,
    examples: [
      {
        title: "Analyze one local JavaScript application",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          format: "auto",
        },
      },
    ],
  },
  {
    name: "reconcile_javascript_runtime",
    ...toolContractMetadata("reconcile_javascript_runtime"),
    description:
      "Reconcile verified static JavaScript application graphs with existing passive web/Electron CDP, passive V8 Inspector, or provider-owned active Electron Evidence. Active Electron captures contribute an explicitly partial target-only runtime record; they never invent renderer scripts, frames, workers, or execution claims. Exact captured-source digests take priority over caller-declared file/URL mappings; target, frame, script, and worker ambiguity remains explicit, and source-map authority stays separate.",
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
  {
    name: "capture_electron_scenario",
    ...toolContractMetadata("capture_electron_scenario"),
    description:
      "Use this for a provider-owned Electron run when passive CDP or Inspector observation cannot exercise application behavior. REA owns startup and teardown, accepts caller-defined click/wait actions plus window-targeted renderer reload/crash and synthetic open-url/second-instance delivery, and returns correlated window/WebContents/process/preload/session/navigation/shell/IPC evidence without retaining payload values. Actions wait for completion or request cancellation; a missing click target can keep the request pending. Results identify observed and unavailable event families, coverage status, action targets, and truncation. Cleanup failures retain collected observations with explicit cleanup uncertainty. External shell, navigation, permission, download, popup, updater, and OS-integration effects are blocked and recorded. Use passive Electron tools for observation-only work.",
    kind: "electron-provider",
    inputSchema: electronActiveObservationInputSchema,
    outputSchema: evidenceResultOf(electronActiveObservationResultSchema),
    examples: [
      { title: "Exercise an owned Electron application", input: activeExample },
    ],
  },
] as const satisfies readonly ToolContract[];
