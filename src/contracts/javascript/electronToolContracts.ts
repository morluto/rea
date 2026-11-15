import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../../domain/localPath.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { electronFuseOutputSchemas } from "../toolOutputSchemaGroups.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { inspectElectronFusesInputSchema } from "../../domain/electron/electronFuses.js";
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
  javaScriptRoutesCompleteDeliveryShape,
  javaScriptRoutesSummaryDeliveryShape,
} from "../../domain/analysisView/javascriptRoutesView.js";
import {
  javaScriptRoutesViewResultSchema,
  javascriptApplicationSummaryViewResultSchema,
} from "../../domain/analysisView/analysisViewResult.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { reconcileJavaScriptRuntimeRequestSchema } from "./applicationWorkflowInputContracts.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "./javascriptRuntimeReconciliationExample.js";

const listOutputSchema = evidenceResultOf(electronTargetListSchema);
const inspectionOutputSchema = evidenceResultOf(electronPageInspectionSchema);
const javascriptApplicationMcpInputSchema =
  analyzeJavaScriptApplicationInputSchema.extend({
    input_path: absoluteLocalPathStringSchema.describe(
      "Absolute path to the JavaScript application on the machine running REA.",
    ),
  });
/** Caller-selected delivery of a completed JavaScript application analysis. */
export const analyzeJavaScriptApplicationRequestSchema = z
  .discriminatedUnion("detail", [
    javascriptApplicationMcpInputSchema.extend(
      javaScriptRoutesCompleteDeliveryShape,
    ),
    javascriptApplicationMcpInputSchema.extend(
      javaScriptRoutesSummaryDeliveryShape,
    ),
  ])
  .meta({ "x-rea-root-discriminator": "detail" });
const applicationOutputSchema = analysisDetailOutputSchemaOf(
  javascriptApplicationAnalysisResultSchema,
  z.union([
    javascriptApplicationSummaryViewResultSchema,
    javaScriptRoutesViewResultSchema,
  ]),
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
      'Build a static application graph from a local ASAR or extracted JavaScript app without executing it. Supply input_path, e.g. {input_path:"/apps/client",source_paths:["main.js"],detail:"summary"}. Copy source_paths exactly from the inventory, not host-absolute paths inferred from input_path. Returns nodes, edges, semantic relations, integrity contradictions, coverage and unknowns. source_paths limits source analysis to exact inventoried paths without narrowing inventory or artifact identity; dependencies are not implicitly analyzed and unselected sources remain unknown. detail summary reduces delivery, retaining complete Evidence for inspect_analysis_view; it does not reduce analysis. With summary detail, view {kind:"javascript-routes",collection:"routes",offset:0,limit:64} selects static route patterns; static routes do not prove reachability or the complete route set. Integrity mismatches fail by default; record-and-continue retains untrusted observed bytes and partial coverage. analysis_timeout_ms is a per-source provider budget. A host-only timeout needs a longer client deadline, not that budget; do not repeat unchanged work or assume it stopped. If configuration cannot be edited, report the host setting (Codex: mcp_servers.<server>.tool_timeout_sec, seconds).',
    kind: "electron-provider",
    inputSchema: analyzeJavaScriptApplicationRequestSchema,
    outputSchema: applicationOutputSchema,
    examples: [
      {
        title: "Analyze one local JavaScript application",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          format: "auto",
          integrity_policy: "fail",
        },
      },
      {
        title: "Analyze selected entry sources before unrelated vendor files",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          source_paths: ["package.json", "main.js", "preload.js"],
          detail: "summary",
        },
      },
      {
        title: "Retain the complete analysis and return its summary view",
        input: {
          input_path: "/Applications/Example.app/Contents/Resources/app.asar",
          detail: "summary",
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
    inputSchema: reconcileJavaScriptRuntimeRequestSchema,
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
      "Launch and exercise an owned Electron app when passive CDP/Inspector observation cannot answer the question. REA owns startup/teardown; selected click/wait, renderer reload/crash and synthetic open-url/second-instance actions change runtime behavior. Returns correlated window/WebContents/process/preload/session/navigation/shell/IPC observations without payload values, plus action targets and coverage/truncation. Actions wait for completion or cancellation; a missing click target can remain pending. External shell, navigation, permission, download, popup, updater and OS-integration effects are blocked and recorded. Cleanup failures retain observations with explicit uncertainty. Use inspect_electron_page or observe_javascript_runtime for passive observation.",
    kind: "electron-provider",
    inputSchema: electronActiveObservationInputSchema,
    outputSchema: evidenceResultOf(electronActiveObservationResultSchema),
    examples: [
      { title: "Exercise an owned Electron application", input: activeExample },
    ],
  },
  {
    name: "inspect_electron_fuses",
    ...toolContractMetadata("inspect_electron_fuses"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect packaged Electron fuse bytes in one local macOS app bundle, Electron Framework binary, Windows PE executable, or Linux ELF executable. Returns the artifact digest, per-slice wire version, fuse index, version-1 name, state, and raw byte, plus derived implications for Inspector flags, ELECTRON_RUN_AS_NODE, embedded ASAR integrity, and app.asar-only loading. A missing sentinel is unknown fuse state. Reads artifact bytes only and does not modify the selected file or open a runtime target.",
    inputSchema: inspectElectronFusesInputSchema,
    outputSchema: electronFuseOutputSchemas.inspect_electron_fuses,
    examples: [
      {
        title: "Read packaged Electron fuse state",
        input: { path: "/Applications/Example.app" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
