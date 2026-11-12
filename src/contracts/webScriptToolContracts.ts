import { z } from "zod";
import { analysisDetailOutputSchemaOf } from "./analysisDetail.js";
import {
  webSourceLocationCompleteDeliveryShape,
  webSourceLocationSummaryDeliveryShape,
} from "../domain/analysisView/webSourceLocationView.js";
import {
  webSourceLocationSummaryViewResultSchema,
  webSourceLocationMatchesViewResultSchema,
  webSourceLocationTextViewResultSchema,
} from "../domain/analysisView/analysisView.js";
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
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  webSourceLocationInputSchema,
  webSourceLocationResultSchema,
} from "../domain/webSourceLocation.js";

export const webSourceLocationRequestSchema = z
  .discriminatedUnion("detail", [
    webSourceLocationInputSchema.extend(webSourceLocationCompleteDeliveryShape),
    webSourceLocationInputSchema.extend(webSourceLocationSummaryDeliveryShape),
  ])
  .meta({ "x-rea-root-discriminator": "detail" });

/** Local captured-script publication contracts shared by CLI and MCP. */
export const WEB_SCRIPT_TOOL_CONTRACTS = [
  {
    name: "trace_web_source_location",
    ...toolContractMetadata("trace_web_source_location"),
    description:
      'Map one generated position in an exported script through a caller-paired local source map, verifying manifest/script/map byte identities. Returns all equal-position matches, original positions, resolved source URLs and embedded sourcesContent; pairing does not prove deployment authenticity or execution. Lines are one-based, columns zero-based UTF-16; lookup uses the greatest generated position <= requested across lines. Regular maps and inline indexed sections only; external section URLs are unsupported. No network or application execution; decoding uses an owned codec process. Complete delivery is default. detail summary retains Evidence; view {kind:"source-location",collection:"matches",offset:0,limit:64} pages match metadata. source-text additionally requires match_index and pages UTF-16 text. inspect_analysis_view reuses the retained parent; export_evidence_bundle preserves it. source_map_limits changes byte/record/heap admission per call; decode_timeout_ms is separate. Refusals name the exhausted control; cleanup may outlast the deadline.',
    kind: "application",
    inputSchema: webSourceLocationRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      webSourceLocationResultSchema,
      z.union([
        webSourceLocationSummaryViewResultSchema,
        webSourceLocationMatchesViewResultSchema,
        webSourceLocationTextViewResultSchema,
      ]),
    ),
    examples: [
      {
        title:
          "Trace a selected captured JavaScript point with retained compact delivery",
        input: {
          detail: "summary",
          manifest_path: "/analysis/scripts/manifest.json",
          script_index: 0,
          source_map: {
            path: "/analysis/app.js.map",
            url: "https://example.test/app.js.map",
          },
          generated_position: { line: 1, column: 25 },
        },
      },
    ],
  },
  {
    name: "trace_web_module_imports",
    ...toolContractMetadata("trace_web_module_imports"),
    description:
      "Resolve native ES imports/re-exports from one script in a local export_web_scripts manifest. Verifies the selected source digest/size and returns source positions, resolved URLs/errors and every matching captured candidate. URL query/fragment identities remain distinct; computed imports, bundler IDs and execution remain unknown. Supply importer_url when inline/document-base context is unknown and an import_map when needed. Literal resolution requires absolute REA_BROWSER_EXECUTABLE: caller-supplied Chromium runs only a trusted REA resolver stub with page requests fulfilled locally or blocked, without captured app execution or asset refetch. The native deadline is 20 seconds; cleanup may extend it.",
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
