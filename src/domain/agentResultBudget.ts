import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
} from "./analysisResourceLimits.js";
import { currentAnalysisSettingOverride } from "./analysisOperationSnapshot.js";
import { DEFAULT_EVIDENCE_JSON_PAGE_CODE_UNITS } from "./analysisView/evidenceJsonView.js";
import type { JsonValue } from "./jsonValue.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";

/** Registered runtime setting that owns the agent delivery budget. */
export const AGENT_RESULT_BUDGET_SETTING =
  "delivery.agent_result_budget_bytes" as const;

/**
 * Documented estimate for JSON tool results, used only to label budgets and
 * sizes in tokens. Real tokenizers vary with content; digests and
 * identifiers tokenize denser than prose.
 */
export const ESTIMATED_JSON_BYTES_PER_TOKEN = 4;

/** The budget in force for this operation and where it came from. */
export interface AgentResultBudget {
  readonly bytes: number;
  readonly source: "default" | "runtime";
}

/** The accepted operation's override, or the built-in default. */
export const currentAgentResultBudget = (): AgentResultBudget => {
  const override = currentAnalysisSettingOverride(AGENT_RESULT_BUDGET_SETTING);
  return override === undefined
    ? { bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES, source: "default" }
    : { bytes: override, source: "runtime" };
};

/** Estimated tokens for a JSON byte count; a label, never a measurement. */
export const estimatedJsonTokens = (bytes: number): number =>
  Math.ceil(bytes / ESTIMATED_JSON_BYTES_PER_TOKEN);

/**
 * Exact UTF-8 JSON bytes of a complete result when it exceeds the budget, or
 * undefined when it fits. A fitting result stops measuring at the budget.
 */
export const agentBudgetOverflowBytes = (
  value: JsonValue,
  budget: AgentResultBudget,
): number | undefined =>
  jsonValueByteLength(value, budget.bytes) <= budget.bytes
    ? undefined
    : jsonValueByteLength(value);

/** How the caller reaches the complete Evidence that a summary replaced. */
export type AgentBudgetRecovery =
  | { readonly kind: "session"; readonly evidenceId: string }
  | {
      readonly kind: "evidence-file";
      readonly evidenceId: string;
      readonly path: string | undefined;
    }
  | { readonly kind: "not-retained" };

const pageCall = (
  command: string,
  evidenceId: string,
  source: string,
): string =>
  `${command} {"source":${source},"view":{"kind":"evidence-json","offset":0,"limit":${String(DEFAULT_EVIDENCE_JSON_PAGE_CODE_UNITS)}}} pages its exact JSON; follow coverage.next_offset. The producer's own views select facts from ${evidenceId} more cheaply`;

/**
 * The limitation an over-budget delivery carries: the effective budget, the
 * complete size, where the complete Evidence is and the call that reads it.
 */
export const agentBudgetLimitation = (input: {
  readonly operation: string;
  readonly completeBytes: number;
  readonly budget: AgentResultBudget;
  readonly recovery: AgentBudgetRecovery;
}): string => {
  const { budget, completeBytes, recovery } = input;
  const sizes = `Complete ${input.operation} Evidence is ${String(completeBytes)} bytes (about ${String(estimatedJsonTokens(completeBytes))} tokens, estimated at ${String(ESTIMATED_JSON_BYTES_PER_TOKEN)} bytes per token), over the agent delivery budget of ${String(budget.bytes)} bytes (about ${String(estimatedJsonTokens(budget.bytes))} tokens; ${AGENT_RESULT_BUDGET_SETTING}, source ${budget.source}, range ${String(MINIMUM_AGENT_RESULT_BUDGET_BYTES)}..${String(MAXIMUM_AGENT_RESULT_BUDGET_BYTES)}), so this is its summary. Nothing was truncated.`;
  if (recovery.kind === "session")
    return `${sizes} The complete Evidence is retained in this session as ${recovery.evidenceId}: ${pageCall("inspect_analysis_view", recovery.evidenceId, `{"kind":"retained-evidence","evidence_id":"${recovery.evidenceId}"}`)}. Pass detail complete for all of it inline, or raise ${AGENT_RESULT_BUDGET_SETTING} with update_analysis_settings.`;
  if (recovery.kind === "evidence-file")
    return `${sizes} The complete Evidence ${recovery.evidenceId} is in the --evidence_output bundle${recovery.path === undefined ? "" : ` ${recovery.path}`}: rea ${pageCall("inspect-analysis-view", recovery.evidenceId, `{"kind":"evidence-file","path":${JSON.stringify(recovery.path ?? "<bundle path>")},"evidence_id":"${recovery.evidenceId}"}`)}. Pass --detail complete for all of it inline.`;
  return `${sizes} This invocation selected no --evidence_output, so the complete Evidence was not retained: rerun with --evidence_output PATH to keep it for inspect-analysis-view, or with --detail complete for all of it inline.`;
};
