import { API_SURFACE_EXAMPLE } from "./analysisViewApiSurfaceExample.js";
import { ENVIRONMENT_MANIFEST_EXAMPLE } from "./analysisViewEnvironmentManifestExample.js";
import {
  analysisViewResultSchema,
  inspectAnalysisViewInputSchema,
} from "../domain/analysisView/analysisView.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Selected views of completed layout, JavaScript, native, inventory, WASM, Mach-O, Interface Builder and web network Evidence. */
export const ANALYSIS_VIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_view",
    ...toolContractMetadata("inspect_analysis_view"),
    kind: "application",
    description:
      'Inspect selected views of completed Evidence without rerunning analysis or reopening its source. Use source: {kind: "retained-evidence", evidence_id: "<parent_evidence_id>"}; summary receipts name the complete parent in normalized_result.parent_evidence_id. Portable sources use {kind: "inline", evidence: <complete Evidence>} or {kind: "evidence-file", path: "<absolute path>", evidence_id?: "<id in bundle>"}. Source kind is required. Choose a view compatible with the parent operation. For format-specific kinds, selectors and examples, call search_guidance with query "inspect_analysis_view <format or view kind>", then read_guidance_section with the returned locator; hot/cold clients discover those named tools first. Pagination preserves parent identity, source coverage, limitations and unknowns; exhausting a page does not establish complete source discovery. Text offsets use UTF-16 code units where documented. Reduce the selected page or export complete retained Evidence if the reply exceeds the transport budget.',
    inputSchema: inspectAnalysisViewInputSchema,
    outputSchema: evidenceResultOf(analysisViewResultSchema),
    examples: [
      {
        title:
          "Page endpoint observations from retained web bundle analysis Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "web-bundle",
            collection: "endpoints",
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title:
          "Page selected native inventory fields without repeating the complete list",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "native-inventory",
            offset: 0,
            limit: 32,
            fields: ["value"],
          },
        },
      },
      {
        title: "Read exact inventory paths from retained inspection Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "inventory",
            collection: "occurrences",
            logical_paths: ["package.json", "main.js"],
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title: "Group requests from retained HAR Evidence",
        input: API_SURFACE_EXAMPLE.input,
      },
      {
        title: "Project an environment manifest from retained HAR Evidence",
        input: ENVIRONMENT_MANIFEST_EXAMPLE.input,
      },
      {
        title: "Summarize retained analysis Evidence, including WASM",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: { kind: "summary" },
        },
      },
      {
        title: "Read one ELF section from retained layout Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "item",
            collection: "sections",
            selector: { name: ".text" },
          },
        },
      },
      {
        title: "Page native high-pcode operations from retained Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "native",
            facet: "value_flow_operations",
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title: "Page module identities from retained application Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "page",
            collection: "modules",
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title:
          "Read selected metadata and native facts by exact retained paths",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "javascript-facts",
            where: { paths: ["package.json", "build/Release/addon.node"] },
            property_keys: [
              "name",
              "version",
              "bytes",
              "availability",
              "operation",
              "analysis_status",
            ],
            include_available_property_keys: true,
            offset: 0,
            limit: 32,
          },
        },
      },
      {
        title:
          "Read typed module reference facts from retained application Evidence",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "javascript",
            collection: "modules",
            projection: "references",
            where: { path: "main.js", kind: "javascript-module" },
            offset: 0,
            limit: 64,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
