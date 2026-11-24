import { z } from "zod";
import {
  endpointComparisonPageViewResultSchema,
  endpointComparisonSummaryViewResultSchema,
} from "../domain/analysisView/summarySchemas/endpointComparisonSummarySchemas.js";
import { staticObservedEndpointComparisonSchema } from "../domain/javascript/staticObservedEndpointSchemas.js";
import { compareStaticObservedEndpointsRequestSchema } from "./javascript/applicationWorkflowInputContracts.js";
import { STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE } from "./javascript/staticObservedEndpointExample.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Standalone contract for lazy CLI registration of `compare-static-and-observed-endpoints`. */
export const COMPARE_STATIC_AND_OBSERVED_ENDPOINTS_TOOL_CONTRACT = {
  name: "compare_static_and_observed_endpoints",
  cli: true,
  ...toolContractMetadata(
    "compare_static_and_observed_endpoints",
    evidenceEffects,
  ),
  description:
    "Compare static JavaScript endpoints with requests recorded in HAR Evidence, supplied inline or retained; acquires no files, targets or URLs. Returns exact or inferred template pairings and explicit unknowns; root-relative targets need a declared origin. Not-observed requires an exercised origin, all parent records retained and none excluded; it never means hidden, unused or inaccessible. Default summary retains the full comparison for inspect_analysis_view kind endpoint-comparison (static-endpoints, observed-groups, matches); a selected view overrides detail, and detail complete returns all facts. Copies no query strings, fragments, headers or bodies. Sensitive-declaration parents are refused; the 96 MiB representation budget covers source admission and derived state.",
  kind: "application",
  inputSchema: compareStaticObservedEndpointsRequestSchema,
  outputSchema: evidenceResultOf(
    z.union([
      staticObservedEndpointComparisonSchema,
      endpointComparisonSummaryViewResultSchema,
      endpointComparisonPageViewResultSchema,
    ]),
  ),
  examples: [
    {
      title: "Compare retained static endpoints with an offline HAR",
      input: STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE,
    },
  ],
} as const satisfies ToolContract;
