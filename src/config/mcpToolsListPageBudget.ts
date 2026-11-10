import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import {
  DEFAULT_MCP_TOOLS_LIST_PAGE_BYTES,
  MAXIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
  MINIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const MCP_TOOLS_LIST_PAGE_BUDGET_SETTING =
  "REA_MCP_TOOLS_LIST_PAGE_BYTES";

/** Effective tools/list page budget and where its byte count came from. */
export interface McpToolsListPageBudget {
  readonly setting: typeof MCP_TOOLS_LIST_PAGE_BUDGET_SETTING;
  readonly bytes: number;
  readonly source: "default" | "setting";
  readonly defaultBytes: number;
  readonly floorBytes: number;
  readonly maximumBytes: number;
}

export const DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET: McpToolsListPageBudget = {
  setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
  bytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BYTES,
  source: "default",
  defaultBytes: DEFAULT_MCP_TOOLS_LIST_PAGE_BYTES,
  floorBytes: MINIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
  maximumBytes: MAXIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
};

const pageBudgetConstraint = `${MCP_TOOLS_LIST_PAGE_BUDGET_SETTING} must be a positive decimal integer from ${String(MINIMUM_MCP_TOOLS_LIST_PAGE_BYTES)} to ${String(MAXIMUM_MCP_TOOLS_LIST_PAGE_BYTES)} bytes; the default is ${String(DEFAULT_MCP_TOOLS_LIST_PAGE_BYTES)} bytes. A page above ${String(MAXIMUM_MCP_TOOLS_LIST_PAGE_BYTES)} bytes cannot fit FastMCP's default SSE event.`;

/** Optional decimal byte count for one tools/list page. */
export const mcpToolsListPageBytesSchema = positiveDecimalIntegerSchema(
  MINIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
  MAXIMUM_MCP_TOOLS_LIST_PAGE_BYTES,
  pageBudgetConstraint,
);

/** Resolve the page budget from one environment value. Invalid values are refused. */
export const parseMcpToolsListPageBudget = (
  value: string | undefined,
): Result<McpToolsListPageBudget, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET);
  const parsed = mcpToolsListPageBytesSchema.safeParse(value);
  return parsed.success
    ? ok({
        ...DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
        bytes: parsed.data,
        source: "setting",
      })
    : err(
        new ConfigurationError(pageBudgetConstraint, {
          settings: [
            {
              setting: MCP_TOOLS_LIST_PAGE_BUDGET_SETTING,
              constraint: pageBudgetConstraint,
            },
          ],
        }),
      );
};

/** Resolve the budget from a composition root's selected environment. */
export const resolveMcpToolsListPageBudget = (
  environment: Readonly<Record<string, string | undefined>>,
): McpToolsListPageBudget => {
  const parsed = parseMcpToolsListPageBudget(
    environment[MCP_TOOLS_LIST_PAGE_BUDGET_SETTING],
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** How to read and change the tools/list page budget. */
export const mcpToolsListPageBudgetRecovery = (
  budget: McpToolsListPageBudget,
): string =>
  [
    `The effective ${budget.setting} value is ${String(budget.bytes)} bytes (source ${budget.source}; default ${String(budget.defaultBytes)} bytes, floor ${String(budget.floorBytes)} bytes, maximum ${String(budget.maximumBytes)} bytes).`,
    `Set ${budget.setting} in the environment that starts REA to a positive decimal integer from ${String(budget.floorBytes)} to ${String(budget.maximumBytes)}, then restart REA.`,
    "One advertised tool that exceeds the effective budget fails tools/list. Splitting that definition or raising the budget is required; repeating the unchanged request fails the same way.",
  ].join(" ");
