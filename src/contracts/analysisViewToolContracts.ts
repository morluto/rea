import {
  analysisViewResultSchema,
  inspectAnalysisViewInputSchema,
} from "../domain/analysisView/analysisView.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const RETAINED_EXAMPLE_ID = `ev_${"a".repeat(64)}`;

/** Selected views of already completed layout, JavaScript and native function Evidence. */
export const ANALYSIS_VIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_analysis_view",
    ...toolContractMetadata("inspect_analysis_view"),
    kind: "application",
    description:
      "Inspect selected views of completed binary-layout, JavaScript application or native analyze_function Evidence without repeating analysis. Use an exact same-session retained evidence_id or portable inline Evidence. Native views select procedure, bounded pseudocode, assembly, callers/callees, references and high-pcode. Use offset and limit of at most 256 rows or UTF-16 code units for pseudocode. Returns artifact identity, parent Evidence ID, a distinct view digest, coverage, limitations and unknowns. Actual serialized size determines MCP transport admission; choose a smaller page or export the complete retained Evidence if needed.",
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
    ],
  },
] as const satisfies readonly ToolContract[];
