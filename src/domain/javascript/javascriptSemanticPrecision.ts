import { z } from "zod";

/** Per-source evaluator work, distinct from retained graph size and worker memory. */
export const JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS = {
  primitive_candidates: 256,
  primitive_bytes: 1_048_576,
  expression_depth: 256,
  getter_expansions: 512,
  alias_selections: 512,
  wrapper_visits: 1_000_000,
  wrapper_depth: 128,
} as const;

const work = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const javaScriptSemanticPrecisionSchema = z.strictObject({
  primitive_candidates: work.exactOptional(),
  primitive_bytes: work
    .exactOptional()
    .describe(
      `Conservative JSON string-payload allowance per evaluated candidate set; default ${String(JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS.primitive_bytes)}. Admission charges six bytes per UTF-16 code unit plus quotes before creating concatenated strings, so ordinary ASCII can exhaust this estimate before its actual JSON encoding reaches the selected byte count. Independent of graph, checkpoint and worker-transfer budgets.`,
    ),
  expression_depth: work.exactOptional(),
  getter_expansions: work.exactOptional(),
  alias_selections: work.exactOptional(),
  wrapper_visits: work.exactOptional(),
  wrapper_depth: work.exactOptional(),
});
export type JavaScriptSemanticPrecisionInput = z.output<
  typeof javaScriptSemanticPrecisionSchema
>;
export type JavaScriptSemanticPrecision = {
  readonly [Key in keyof typeof JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS]: number;
};

/** Resolve once at source admission; consumers share this exact policy. */
export const resolveJavaScriptSemanticPrecision = (
  input?: JavaScriptSemanticPrecisionInput,
): JavaScriptSemanticPrecision =>
  input === undefined
    ? JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS
    : { ...JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS, ...input };
