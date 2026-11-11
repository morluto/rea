import {
  goBinarySchema,
  inspectGoBinaryInputSchema,
} from "../../domain/go/goBinary.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import { goBinarySummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";

/** Static Go metadata is independent of active native-analysis providers and host toolchains. */
export const GO_TOOL_CONTRACTS = [
  {
    name: "inspect_go_binary",
    ...toolContractMetadata("inspect_go_binary"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Read embedded Go compiler, module, dependency/replacement and build-setting metadata from a local ELF, PE or selected Mach-O slice without running it or requiring Go. include_string_literals: true adds inferred static UTF-8 literals; runtime use and dependency completeness remain unknown. Missing build info does not prove the image is not Go. Default complete returns artifact SHA-256, source ranges and original metadata; detail summary retains it for inspect_analysis_view kind go, collections dependencies/settings/string_literals, with parent_evidence_id. Slice ranges remain offsets in the original universal file. No function/type/source recovery. Increase only the reported per-call budget and retry the same artifact; it does not raise parser or MCP delivery limits. Malformed/unsupported inputs fail explicitly.",
    inputSchema: inspectGoBinaryInputSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      goBinarySchema,
      goBinarySummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect embedded build provenance",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
