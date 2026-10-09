import {
  MEASURED_PAGE_LIMIT,
  analysisViewResultSchema,
  inspectAnalysisViewInputSchema,
} from "../domain/analysisView/analysisView.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Selected views of already completed layout and JavaScript analysis Evidence. */
export const ANALYSIS_VIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_view",
    ...toolContractMetadata("inspect_analysis_view"),
    kind: "application",
    description:
      "Project a caller-selected view of already completed inspect_binary_layout or analyze_javascript_application Evidence without re-running analysis. Source is an exact same-session retained reference or portable inline Evidence. Views are a summary, a layout mitigations or linkage facet, one section/symbol/module, or a stable page. Page limit is required and at most " +
      String(MEASURED_PAGE_LIMIT) +
      ", the largest page that keeps a worst-case identity row inside the pinned 10 MiB MCP stdio budget after Evidence wrapping, four-fold MCP encoding, and 25% headroom. Returns the projected facts inline with artifact identity, parent Evidence ID, a view digest of the projected bytes, coverage, limitations, and unknowns. Does not silently truncate a complete schema. Unsupported parent operations, ambiguous names, and malformed views fail with typed recovery.",
    inputSchema: inspectAnalysisViewInputSchema,
    outputSchema: evidenceResultOf(analysisViewResultSchema),
    examples: [
      {
        title: "Summarize retained JavaScript application Evidence",
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
    ],
  },
] as const satisfies readonly ToolContract[];
