import {
  inspectErlangBeamInputSchema,
  erlangBeamSchema,
} from "../../domain/erlang/beam.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import { z } from "zod";
import {
  erlangBeamSummaryViewResultSchema,
  erlangBeamTableViewResultSchema,
} from "../../domain/analysisView/analysisViewResult.js";
import {
  erlangBeamCompleteDeliveryShape,
  erlangBeamSummaryDeliveryShape,
} from "../../domain/analysisView/erlangBeamView.js";

/** Delivery selection does not change provider inputs or complete Evidence identity. */
export const inspectErlangBeamRequestSchema = z
  .discriminatedUnion("detail", [
    inspectErlangBeamInputSchema.extend(erlangBeamCompleteDeliveryShape),
    inspectErlangBeamInputSchema.extend(erlangBeamSummaryDeliveryShape),
  ])
  .meta({ "x-rea-root-discriminator": "detail" });

/** Static BEAM inspection is independent of active native-analysis providers. */
export const ERLANG_BEAM_TOOL_CONTRACTS = [
  {
    name: "inspect_erlang_beam",
    ...toolContractMetadata("inspect_erlang_beam"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect an Erlang BEAM IFF file without executing bytecode or requiring Erlang. Returns chunk byte ranges/digests, atoms, exports/imports/lambdas and Code header. Default complete returns full Evidence; detail summary retains it, and an optional beam view selects collection rows in the first call. Reuse inspect_analysis_view kind beam for atoms/exports/imports/lambdas/chunks, exact names/indices/fields and paging. source_index scopes rows to parent/collection, preserving every arity; original atom/lambda indices remain distinct. Missing tables/counts stay null, not empty; runtime absence is unknown. Malformed/truncated input or exhausted budgets fail without partial success.",
    inputSchema: inspectErlangBeamRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      erlangBeamSchema,
      z.union([
        erlangBeamSummaryViewResultSchema,
        erlangBeamTableViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Return selected exports and retain the complete BEAM report",
        input: {
          path: "/artifacts/app.beam",
          detail: "summary",
          view: {
            kind: "beam",
            collection: "exports",
            names: ["module_info"],
            fields: ["function_index", "function", "arity", "label"],
          },
        },
      },
      {
        title: "Inspect the complete BEAM structure",
        input: { path: "/artifacts/app.beam" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
