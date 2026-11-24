import { API_SURFACE_EXAMPLE } from "./analysisViewApiSurfaceExample.js";
import { ENVIRONMENT_MANIFEST_EXAMPLE } from "./analysisViewEnvironmentManifestExample.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisViewRequest.js";
import { analysisViewResultSchema } from "../domain/analysisView/analysisViewResult.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata, evidenceEffects } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Selected views of completed layout, JavaScript, native, inventory, WASM, Mach-O, Interface Builder and web network Evidence. */
export const ANALYSIS_VIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_view",
    cli: true,
    ...toolContractMetadata("inspect_analysis_view", evidenceEffects),
    kind: "application",
    description:
      'Read summaries, selected facts, or pages from completed Evidence without rerunning analysis. Use the producing tool’s retained-view handoff for compatible selectors; the examples here are not exhaustive. Copy normalized_result.parent_evidence_id from a summary into source: {kind: "retained-evidence", evidence_id: "<parent_evidence_id>"}. Other sources are {kind: "inline", evidence: <complete Evidence>} or {kind: "evidence-file", path: "<absolute JSON path>", evidence_id?: "<record ID>"}; select an ID for a multi-record bundle. For native pseudocode use {source: {kind: "retained-evidence", evidence_id: "<parent_evidence_id>"}, view: {kind: "native", facet: "pseudocode", offset: 0, limit: 128}}; procedure_pseudo_code parents support this text facet, while other native function facets require analyze_function. Common views: {kind: "summary"} has no facet; {kind: "inventory", collection: "occurrences", logical_paths: ["package.json"], offset: 0, limit: 64} selects artifact paths, path_globs: ["lib/*/*.so"] selects by whole-path glob, artifact_kinds: ["native-addon"] selects recognized kinds, and order_by: {field: "declared_size", direction: "descending"} ranks rows by size before paging; {kind: "capture", detail: "preview", offset: 0, limit: 20} pages saved network records; {kind: "managed-members", collection: "methods", offset: 0, limit: 64} pages managed members. Use the producer’s named kind for other families; compact schemas may omit nested shapes, so do not invent selectors. Text offsets/limits use UTF-16 code units; row pages count the selected retained collection. Preserve parent identity, null/unavailable values, source coverage, limitations and unknowns; exhausting pages does not prove complete discovery, runtime use or absence. Smaller pages can resolve delivery limits without repeating analysis; complete parent Evidence remains available for export.',
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
        title: "Select native addons by recognized artifact kind",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "inventory",
            collection: "occurrences",
            artifact_kinds: ["native-addon"],
            fields: ["logical_path", "declared_size", "unpacked"],
            offset: 0,
            limit: 64,
          },
        },
      },
      {
        title: "Rank the largest files below an archive directory",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "inventory",
            collection: "occurrences",
            path_globs: ["lib/**"],
            entry_kinds: ["file"],
            order_by: { field: "declared_size", direction: "descending" },
            fields: ["logical_path", "declared_size"],
            offset: 0,
            limit: 16,
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
          "Count distinct IPC channels per operation in one retained source",
        input: {
          source: {
            kind: "retained-evidence",
            evidence_id: RETAINED_EXAMPLE_ID,
          },
          view: {
            kind: "javascript-fact-groups",
            where: { paths: ["preload.js"], kinds: ["ipc-channel"] },
            group_by: ["operation", "channel"],
            offset: 0,
            limit: 256,
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
