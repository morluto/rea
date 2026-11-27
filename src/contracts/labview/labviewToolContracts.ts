import {
  inspectLabviewArtifactInputSchema,
  labviewArtifactSchema,
} from "../../domain/labview/labviewArtifact.js";
import { labviewArtifactSummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/labviewArtifactSummarySchema.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, evidenceEffects } from "../toolEffects.js";

/** Static LabVIEW RSRC inspection is independent of a LabVIEW installation. */
export const LABVIEW_TOOL_CONTRACTS = [
  {
    name: "inspect_labview_artifact",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_labview_artifact", evidenceEffects),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect the RSRC container of a local LabVIEW artifact: a .vi/.ctl/.llb file, or a LabVIEW-built PE whose VI tree is stored in a resource. Returns artifact identity, container header facts, the LabVIEW version recorded by its vers block, and the block inventory with each section's coding and decoded byte count. zlib-coded sections are decoded for their byte count only; no section payload is returned. A missing block-diagram heap (BDH*) or front-panel heap (FPH*) is reported as an explicit limitation rather than reconstructed. Complete detail returns the block inventory inline; summary (or omitted detail over the agent result budget) retains complete Evidence for inspect_analysis_view kind labview-artifact (collections blocks and sections, filterable by block) or evidence-json. Reads existing files only and starts no process; malformed or oversized containers fail rather than return a partial inventory.",
    inputSchema: inspectLabviewArtifactInputSchema.extend({
      detail: analysisDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      labviewArtifactSchema,
      labviewArtifactSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inventory a LabVIEW VI container",
        input: { path: "/artifacts/example.vi" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
