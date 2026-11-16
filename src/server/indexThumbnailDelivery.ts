import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  ToolResultDelivery,
  mcpResponseOverflowProjection,
} from "./ToolResultDelivery.js";
import { measureMcpResultWithinBudget } from "./toolResultEncoding.js";

/** Images duplicate bounded data already present in Evidence, but the complete
 * wire representation must still pass the shared delivery budget. */
export function appendIndexThumbnailContent(
  result: CallToolResult,
  blocks: CallToolResult["content"],
  delivery: ToolResultDelivery,
  contract: ToolContract,
): CallToolResult {
  if (result.isError || blocks.length === 0) return result;
  const combined = { ...result, content: [...result.content, ...blocks] };
  const measured = measureMcpResultWithinBudget(
    combined,
    delivery.resultBudgetBytes,
  );
  if (measured.ok) return combined;
  const projection = mcpResponseOverflowProjection({
    completed: true,
    constraint: "receive-buffer",
    effectiveResponseBytes: delivery.maximumResponseBytes,
    nextStep:
      "Retry with smaller thumbnail_side or max_previews, or max_previews: 0 to receive the same candidate metadata without PNG previews.",
  });
  return delivery.toErrorToolResult(
    new AnalysisResourceConstraintError(
      contract.name,
      "transport",
      projection.reason,
      {
        boundary: "mcp-response",
        result_budget_bytes: delivery.resultBudgetBytes,
        response_bytes_at_least: measured.bytesAtLeast,
        constraint: measured.constraint,
      },
      { remediationAction: projection.remediationAction },
    ),
    contract.returnsTargetContent,
  );
}
