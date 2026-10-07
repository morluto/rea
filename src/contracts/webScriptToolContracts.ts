import {
  exportWebScriptsInputSchema,
  webScriptExportResultSchema,
} from "../domain/webScriptExport.js";
import type { ToolContract } from "./toolContractTypes.js";
import {
  webModuleTraceInputSchema,
  webModuleTraceResultSchema,
} from "../domain/webModuleTrace.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

/** Local captured-script publication contracts shared by CLI and MCP. */
export const WEB_SCRIPT_TOOL_CONTRACTS = [
  {
    name: "trace_web_module_imports",
    ...toolContractMetadata("trace_web_module_imports"),
    description:
      "Trace one exported website script's outgoing native ES imports/re-exports, using exact URL and optional selected import-map context. Reads a local export_web_scripts manifest and verifies the selected source's SHA-256/size; returns source positions, native resolved URLs or exact errors, every matching captured candidate and explicit unknown execution. Query/fragment identities are preserved. Computed imports and bundler IDs remain unknown. Select importer_url for unknown inline/document-base context. Caller-supplied Chromium executes only a trusted REA resolver stub in an owned context with page requests locally fulfilled/blocked; no captured application execution or asset refetch. Requires absolute REA_BROWSER_EXECUTABLE for literal imports. 32 MiB manifest, 16 MiB source, 4 MiB map and 20-second native deadline; cleanup may extend the deadline.",
    kind: "application",
    inputSchema: webModuleTraceInputSchema,
    outputSchema: evidenceResultOf(webModuleTraceResultSchema),
    examples: [
      {
        title: "Trace an exported module under a selected import map",
        input: {
          manifest_path: "/analysis/exported-scripts/manifest.json",
          script_index: 0,
          import_map: {
            path: "/analysis/import-map.json",
            base_url: "https://example.test/app/",
          },
        },
      },
    ],
  },
  {
    name: "export_web_scripts",
    ...toolContractMetadata("export_web_scripts"),
    description:
      "Export JavaScript bytes already retained in one local inspect_web_page or capture_browser_scenario JSON capture (normalized result or complete Evidence). Writes scripts and a digest-verified manifest into an absent absolute output_directory. Returns all source URLs, script or transaction/event references, unavailable states, and an analysis_input for analyze_javascript_application when any bytes were exported. Include script sources in inspect_web_page or select capture.network.response_body in scenarios. No refetch or execution. Safe unambiguous URL layouts preserve relative module paths; versions, query variants, inline scripts, and path collisions are isolated with explicit resolution limitations.",
    kind: "application",
    inputSchema: exportWebScriptsInputSchema,
    outputSchema: evidenceResultOf(webScriptExportResultSchema),
    examples: [
      {
        title: "Export a saved website capture for static JavaScript analysis",
        input: {
          capture_path: "/analysis/capture.json",
          output_directory: "/analysis/exported-scripts",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
