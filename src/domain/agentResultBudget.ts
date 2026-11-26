import { z } from "zod";
import {
  DEFAULT_AGENT_RESULT_BUDGET_BYTES,
  DEFAULT_CLI_RETAINED_EVIDENCE_BYTES,
  MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
  MAXIMUM_CLI_RETAINED_EVIDENCE_BYTES,
  MINIMUM_AGENT_RESULT_BUDGET_BYTES,
  MINIMUM_CLI_RETAINED_EVIDENCE_BYTES,
} from "./analysisResourceLimits.js";
import { currentAnalysisSettingOverride } from "./analysisOperationSnapshot.js";
import type { JsonValue } from "./jsonValue.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";

/** Registered runtime setting that owns the agent delivery budget. */
export const AGENT_RESULT_BUDGET_SETTING =
  "delivery.agent_result_budget_bytes" as const;

/**
 * Documented estimate for JSON tool results, used only to label budgets and
 * sizes in tokens. Real tokenizers vary with content; digests, addresses and
 * identifiers tokenize denser than prose. Three bytes per token follows the
 * Claude Code observation behind the default budget.
 */
export const ESTIMATED_JSON_BYTES_PER_TOKEN = 3;

/** Launch seed for the agent result budget, for one-shot CLI callers too. */
export const AGENT_RESULT_BUDGET_ENVIRONMENT = "REA_AGENT_RESULT_BUDGET_BYTES";

const decimalInteger = /^[1-9]\d*$/u;
const seedConstraint = `${AGENT_RESULT_BUDGET_ENVIRONMENT} must be a decimal integer from ${String(MINIMUM_AGENT_RESULT_BUDGET_BYTES)} to ${String(MAXIMUM_AGENT_RESULT_BUDGET_BYTES)} bytes; the default is ${String(DEFAULT_AGENT_RESULT_BUDGET_BYTES)}.`;

/** Launch seed admission, shared with settings inspection and doctor. */
export const agentResultBudgetBytesSchema = z
  .string()
  .regex(decimalInteger, { error: seedConstraint })
  .transform(Number)
  .pipe(
    z
      .int()
      .min(MINIMUM_AGENT_RESULT_BUDGET_BYTES, { error: seedConstraint })
      .max(MAXIMUM_AGENT_RESULT_BUDGET_BYTES, { error: seedConstraint }),
  );

/** Registered setting that bounds the CLI's retained over-budget Evidence. */
export const CLI_RETAINED_EVIDENCE_SETTING =
  "delivery.cli_retained_evidence_bytes" as const;

/** Its launch seed; `0` turns CLI retention off. */
export const CLI_RETAINED_EVIDENCE_ENVIRONMENT =
  "REA_CLI_RETAINED_EVIDENCE_BYTES";

const retentionConstraint = `${CLI_RETAINED_EVIDENCE_ENVIRONMENT} must be a decimal integer from ${String(MINIMUM_CLI_RETAINED_EVIDENCE_BYTES)} to ${String(MAXIMUM_CLI_RETAINED_EVIDENCE_BYTES)} bytes; 0 turns retention off and the default is ${String(DEFAULT_CLI_RETAINED_EVIDENCE_BYTES)}.`;

/** Launch seed admission for the retained CLI Evidence cache size. */
export const cliRetainedEvidenceBytesSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u, { error: retentionConstraint })
  .transform(Number)
  .pipe(
    z
      .int()
      .min(MINIMUM_CLI_RETAINED_EVIDENCE_BYTES, { error: retentionConstraint })
      .max(MAXIMUM_CLI_RETAINED_EVIDENCE_BYTES, { error: retentionConstraint }),
  );

/**
 * Total bytes the CLI may keep in its retained-Evidence cache: the default
 * when the seed is unset, and 0 (off) for `0` or an invalid seed, so an
 * invalid seed writes nothing, as before retention existed. Settings
 * inspection and doctor report an invalid seed.
 */
export const cliRetainedEvidenceBytes = (seed: string | undefined): number => {
  if (seed === undefined) return DEFAULT_CLI_RETAINED_EVIDENCE_BYTES;
  const parsed = cliRetainedEvidenceBytesSchema.safeParse(seed);
  return parsed.success ? parsed.data : 0;
};

/** The budget in force for this operation and where it came from. */
export interface AgentResultBudget {
  readonly bytes: number;
  readonly source: "default" | "setting" | "runtime";
}

/**
 * The accepted operation's override, then the launch seed, then the built-in
 * default. An invalid seed is not replaced by the default: delivery is not
 * budgeted (complete, as before the budget existed), and settings inspection
 * and doctor report the seed. A delivery budget never refuses work.
 */
export const currentAgentResultBudget = (
  /** The launch seed from the environment the CLI or server captured. */
  seed: string | undefined,
): AgentResultBudget | undefined => {
  const override = currentAnalysisSettingOverride(AGENT_RESULT_BUDGET_SETTING);
  if (override !== undefined) return { bytes: override, source: "runtime" };
  if (seed === undefined)
    return { bytes: DEFAULT_AGENT_RESULT_BUDGET_BYTES, source: "default" };
  const parsed = agentResultBudgetBytesSchema.safeParse(seed);
  return parsed.success ? { bytes: parsed.data, source: "setting" } : undefined;
};

/** Estimated tokens for a JSON byte count; a label, never a measurement. */
export const estimatedJsonTokens = (bytes: number): number =>
  Math.ceil(bytes / ESTIMATED_JSON_BYTES_PER_TOKEN);

/**
 * The one decision for an omitted `detail`: the exact UTF-8 JSON bytes of
 * complete Evidence when it is to be delivered as its retained summary, or
 * undefined to deliver it complete. An explicit `detail` decides for itself.
 * Evidence is summarized only when it exceeds the budget, the caller can
 * reach the retained record, and the caller can page the summary; an
 * invalid launch seed (no budget) leaves delivery unbudgeted. A fitting
 * result stops measuring at the budget.
 *
 * Evidence nested in a larger result, such as a failure's partial
 * observation, has only the budget its envelope leaves: `envelopeBytes`
 * are the bytes the rest of that result already uses. The envelope itself
 * is never budgeted.
 */
export const budgetedSummaryBytes = (input: {
  readonly detail: unknown;
  readonly evidence: JsonValue;
  readonly budget: AgentResultBudget | undefined;
  readonly retained: boolean;
  readonly pageable: boolean;
  readonly envelopeBytes?: number;
}): number | undefined => {
  const { budget, evidence } = input;
  if (
    input.detail !== undefined ||
    budget === undefined ||
    !input.retained ||
    !input.pageable
  )
    return undefined;
  const remaining = Math.max(0, budget.bytes - (input.envelopeBytes ?? 0));
  return jsonValueByteLength(evidence, remaining) <= remaining
    ? undefined
    : jsonValueByteLength(evidence);
};

/** Result field that carries a budgeted partial observation's delivery facts. */
export const PARTIAL_OBSERVATION_DELIVERY = "partial_observation_delivery";

/**
 * Bytes a failure uses besides its partial observation: the envelope the
 * observation must fit beside. Its code, retry and recovery facts are
 * always delivered whole.
 */
export const failureEnvelopeBytes = (failure: {
  readonly [key: string]: JsonValue | undefined;
  readonly details?: JsonValue | undefined;
}): number => {
  const details =
    failure.details !== null &&
    typeof failure.details === "object" &&
    !Array.isArray(failure.details)
      ? { ...failure.details, partial_observation: null }
      : failure.details;
  return jsonValueByteLength({
    ...failure,
    ...(details === undefined ? {} : { details }),
  } as JsonValue);
};

/** Where the complete Evidence that a summary replaced can be read. */
export type AgentBudgetRecovery =
  | { readonly kind: "session" }
  | { readonly kind: "evidence-file"; readonly path: string | undefined }
  /** The CLI's private retained-Evidence cache, by default. */
  | { readonly kind: "cache-file"; readonly path: string }
  /** Nothing was written; `reason` says why when retention was attempted. */
  | { readonly kind: "not-retained"; readonly reason?: string };

/**
 * Delivery facts for a result replaced by its summary. They describe the
 * delivery, not the analysis, so they travel beside the summary record and
 * never change its identity.
 */
export interface AgentBudgetDelivery {
  readonly kind: "agent-budget-summary";
  readonly setting: typeof AGENT_RESULT_BUDGET_SETTING;
  readonly budget_bytes: number;
  readonly budget_source: AgentResultBudget["source"];
  readonly budget_minimum: number;
  readonly budget_maximum: number;
  readonly complete_bytes: number;
  /** Estimated at ESTIMATED_JSON_BYTES_PER_TOKEN; not a tokenizer count. */
  readonly estimated_complete_tokens: number;
  readonly evidence_id: string;
  readonly retained: AgentBudgetRecovery["kind"];
  /** The view call that pages the complete record, when it was retained. */
  readonly next?: {
    readonly operation: "inspect_analysis_view";
    readonly arguments: {
      readonly source: Readonly<Record<string, string>>;
      readonly view: { readonly kind: "evidence-json"; readonly offset: 0 };
    };
  };
  /**
   * For an invocation that retained nothing: the exact arguments to add to
   * the same command, for complete Evidence inline or saved to a new bundle.
   * Caller inputs are never echoed, since they can carry access credentials.
   */
  readonly rerun?: {
    readonly complete: readonly string[];
    readonly retained: readonly string[];
  };
  /** Why the CLI's default retention wrote nothing, when it was attempted. */
  readonly retention_failure?: string;
  readonly note: string;
}

/** Placeholder for the caller's choice of a new bundle path. */
export const EVIDENCE_OUTPUT_PLACEHOLDER = "<new-bundle-path>";

const RERUN_ARGUMENTS: NonNullable<AgentBudgetDelivery["rerun"]> = {
  complete: ["--detail", "complete"],
  retained: ["--evidence_output", EVIDENCE_OUTPUT_PLACEHOLDER],
};

const pageSource = (
  evidenceId: string,
  recovery: AgentBudgetRecovery,
): Readonly<Record<string, string>> | undefined => {
  if (recovery.kind === "session")
    return { kind: "retained-evidence", evidence_id: evidenceId };
  if (
    (recovery.kind === "evidence-file" || recovery.kind === "cache-file") &&
    recovery.path !== undefined
  )
    return {
      kind: "evidence-file",
      path: recovery.path,
      evidence_id: evidenceId,
    };
  return undefined;
};

const recoveryNote = (recovery: AgentBudgetRecovery): string => {
  if (recovery.kind === "session")
    return `It is retained in this session: next pages its exact JSON through inspect_analysis_view (follow coverage.next_offset); the producer's own views select facts more cheaply. Pass detail complete for all of it inline, or raise ${AGENT_RESULT_BUDGET_SETTING} with update_analysis_settings.`;
  if (recovery.kind === "evidence-file")
    return "It is in the --evidence_output bundle: rea inspect-analysis-view with next.arguments pages its exact JSON. Pass --detail complete for all of it inline.";
  if (recovery.kind === "cache-file")
    return `It was saved to REA's private retained-Evidence cache, named by its Evidence ID: rea inspect-analysis-view with next.arguments pages its exact JSON. The cache keeps at most ${CLI_RETAINED_EVIDENCE_SETTING} bytes in total and removes records unused for 7 days. Pass --detail complete for all of it inline, --evidence_output <path> to save it elsewhere, or --no-retain to write nothing.`;
  return `This invocation retained nothing and wrote nothing (no --evidence_output, and --no-retain, ${CLI_RETAINED_EVIDENCE_SETTING} 0, or a failed save named by retention_failure): rerun the same command with rerun.complete (--detail complete) for all of it inline, or with rerun.retained (--evidence_output ${EVIDENCE_OUTPUT_PLACEHOLDER}) to save it for inspect-analysis-view.`;
};

/**
 * The delivery facts for one over-budget result: the effective budget, the
 * complete size, where the complete Evidence is and the call that reads it.
 */
export const agentBudgetDelivery = (input: {
  readonly operation: string;
  readonly evidenceId: string;
  readonly completeBytes: number;
  readonly budget: AgentResultBudget;
  readonly recovery: AgentBudgetRecovery;
}): AgentBudgetDelivery => {
  const { budget, completeBytes, evidenceId, recovery } = input;
  const source = pageSource(evidenceId, recovery);
  return {
    kind: "agent-budget-summary",
    setting: AGENT_RESULT_BUDGET_SETTING,
    budget_bytes: budget.bytes,
    budget_source: budget.source,
    budget_minimum: MINIMUM_AGENT_RESULT_BUDGET_BYTES,
    budget_maximum: MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
    complete_bytes: completeBytes,
    estimated_complete_tokens: estimatedJsonTokens(completeBytes),
    evidence_id: evidenceId,
    retained: recovery.kind,
    ...(source === undefined
      ? {}
      : {
          next: {
            operation: "inspect_analysis_view" as const,
            arguments: {
              source,
              view: { kind: "evidence-json" as const, offset: 0 as const },
            },
          },
        }),
    ...(recovery.kind === "not-retained" ? { rerun: RERUN_ARGUMENTS } : {}),
    ...(recovery.kind === "not-retained" && recovery.reason !== undefined
      ? { retention_failure: recovery.reason }
      : {}),
    note: `Complete ${input.operation} Evidence ${evidenceId} is ${String(completeBytes)} bytes (about ${String(estimatedJsonTokens(completeBytes))} tokens, estimated at ${String(ESTIMATED_JSON_BYTES_PER_TOKEN)} bytes per token), over the agent result budget of ${String(budget.bytes)} bytes (${AGENT_RESULT_BUDGET_SETTING}, source ${budget.source}), so its summary was delivered. Nothing was truncated. ${recoveryNote(recovery)}`,
  };
};
