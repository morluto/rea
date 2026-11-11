import { jsonValueByteLength } from "./jsonValueByteLength.js";
import type { JsonValue } from "./jsonValue.js";
import { isLiteralEndpointCandidate } from "./webBundleEndpointLiterals.js";

/** Literal path/URL candidates retained per script when the setting is unset. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING =
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES" as const;
/** Runtime id accepted by `update_analysis_settings`. The environment name seeds it. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID =
  "web.bundle_endpoint_literal_candidates" as const;
export const DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 1024;
/** Zero retains nothing, so it is not a candidate budget. */
export const MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 1;
/**
 * Largest configurable inventory. 4096 is an REA policy ceiling so this
 * optional list cannot by itself fill the worker result budget. It does not
 * raise that budget.
 */
export const MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 4096;

export const WEB_BUNDLE_ENDPOINT_LITERAL_CODE =
  "web_bundle_endpoint_literal_candidates" as const;

/** Effective per-script ceiling and where that value came from. */
export interface WebBundleEndpointLiteralAdmission {
  readonly maximumCount: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION: WebBundleEndpointLiteralAdmission =
  {
    maximumCount: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    source: "default",
  };

/** Structured omission when unique literal candidates exceed the effective ceiling. */
export interface WebBundleEndpointLiteralLimit {
  readonly coverage: "partial";
  readonly code: typeof WEB_BUNDLE_ENDPOINT_LITERAL_CODE;
  readonly setting: typeof WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID;
  readonly admitted_count: number;
  /** Unique count-ceiling omissions when `omitted_by_count_exact` is true. */
  readonly omitted_by_count: number;
  readonly omitted_by_count_exact: boolean;
  /** Literals dropped because the serialized result would exceed its budget. */
  readonly omitted_by_result_budget: number;
  /** Sum of the two omission counts. Positive whenever this object exists. */
  readonly omitted_count: number;
  readonly maximum_count: number;
  readonly source: "default" | "setting" | "runtime";
  readonly default_count: number;
  readonly floor_count: number;
  readonly maximum_setting_count: number;
  readonly update_mode: "runtime";
  readonly pending_restart: false;
  /** `maximal` means no accepted setting value can admit the omitted literals. */
  readonly ceiling: "adjustable" | "maximal";
}

export const webBundleEndpointLiteralLimit = (
  admission: WebBundleEndpointLiteralAdmission,
  admittedCount: number,
  omittedByCount: number,
  omittedByResultBudget = 0,
  omittedByCountExact = true,
): WebBundleEndpointLiteralLimit | undefined => {
  const omittedCount = omittedByCount + omittedByResultBudget;
  return omittedCount === 0
    ? undefined
    : {
        coverage: "partial",
        code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
        setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
        admitted_count: admittedCount,
        omitted_by_count: omittedByCount,
        omitted_by_count_exact: omittedByCountExact,
        omitted_by_result_budget: omittedByResultBudget,
        omitted_count: omittedCount,
        maximum_count: admission.maximumCount,
        source: admission.source,
        default_count: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        floor_count: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        maximum_setting_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        update_mode: "runtime",
        pending_restart: false,
        ceiling:
          admission.maximumCount >=
          MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES
            ? "maximal"
            : "adjustable",
      };
};

/** Name the effective ceiling, its source, the allowed range, and the runtime update. */
export const webBundleEndpointLiteralLimitMessage = (
  limit: WebBundleEndpointLiteralLimit,
): string =>
  [
    `The effective ${limit.setting} value is ${String(limit.maximum_count)} candidates (source ${limit.source}; default ${String(limit.default_count)}, floor ${String(limit.floor_count)}, maximum ${String(limit.maximum_setting_count)}).`,
    `Retained ${String(limit.admitted_count)} literal endpoint candidates and omitted ${limit.omitted_by_count_exact ? `${String(limit.omitted_count)} further unique literals` : `${String(limit.omitted_count)} further literal occurrences, which is not a unique count`}.`,
    limit.omitted_by_count > 0 && limit.ceiling === "maximal"
      ? `The ${limit.setting} allowance is already the maximum of ${String(limit.maximum_setting_count)}. No accepted value reveals the count-omitted literals. Use the retained candidates and the captured script.`
      : limit.omitted_by_count > 0
        ? `On MCP, call update_analysis_settings with setting ${limit.setting}, action set, and a value from ${String(limit.floor_count)} to ${String(limit.maximum_setting_count)}, then retry the original request. It applies to the next analysis without restarting REA. For CLI or future REA processes, set ${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} in the launch environment.`
        : "Raising the candidate count does not recover literals omitted for the result budget.",
    limit.omitted_by_result_budget > 0
      ? `Omitted ${String(limit.omitted_by_result_budget)} literals because the serialized result would exceed its byte budget.`
      : "",
    "This setting does not raise the worker result budget.",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

interface LiteralCandidateRecord {
  readonly kind: string;
  readonly basis: readonly { readonly detector: string }[];
}

/**
 * Drop path/URL literals whose serialized record, including provenance, does
 * not fit in the worker result that remains after the other script facts.
 * Count omissions stay omitted. Callers reserve checked route facts before
 * choosing this budget; byte drops stay out of the count ceiling.
 */
export const retainLiteralCandidatesWithinResultBudget = <
  T extends LiteralCandidateRecord,
>(
  stableFacts: JsonValue,
  inferences: readonly T[],
  admission: WebBundleEndpointLiteralAdmission,
  omittedByCount: number,
  omittedByCountExact: boolean,
  resultBudgetBytes: number,
): {
  readonly inferences: T[];
  readonly admittedCount: number;
  readonly omittedByCount: number;
  readonly omittedByCountExact: boolean;
  readonly omittedByResultBudget: number;
} => {
  const facts = jsonObject(stableFacts);
  const measured = inferences.map((item) => ({
    item,
    literal: isLiteralEndpointCandidate(item),
    bytes: jsonValueByteLength(item as unknown as JsonValue, resultBudgetBytes),
  }));
  const base = jsonValueByteLength(
    { ...facts, inferences: [] },
    resultBudgetBytes,
  );
  const selected: typeof measured = [];
  let payload = 0;
  let byteDropped = 0;
  const recount = (): void => {
    payload = selected.reduce(
      (sum, slot, index) => sum + slot.bytes + (index === 0 ? 0 : 1),
      0,
    );
  };
  const admitted = (): number =>
    selected.reduce((count, slot) => count + (slot.literal ? 1 : 0), 0);
  const metadataBytes = (): number => {
    const limit = webBundleEndpointLiteralLimit(
      admission,
      admitted(),
      omittedByCount,
      byteDropped,
      omittedByCountExact,
    );
    if (limit === undefined) return 0;
    return (
      jsonValueByteLength("endpoint_literal_candidates") +
      jsonValueByteLength(limit as unknown as JsonValue) +
      2
    );
  };
  const estimated = (): number => base + payload + metadataBytes();
  const dropLastLiteral = (): boolean => {
    const index = selected.findLastIndex((slot) => slot.literal);
    if (index < 0) return false;
    selected.splice(index, 1);
    byteDropped += 1;
    recount();
    return true;
  };
  for (const slot of measured) {
    selected.push(slot);
    recount();
    if (!slot.literal) {
      while (estimated() > resultBudgetBytes && dropLastLiteral());
      continue;
    }
    if (estimated() > resultBudgetBytes) {
      selected.pop();
      recount();
      byteDropped += 1;
      while (estimated() > resultBudgetBytes && dropLastLiteral());
    }
  }
  // One exact check of the object the caller serializes. Trim literals if the
  // incremental estimate missed a comma or key.
  let checks = 0;
  while (checks <= selected.length) {
    const limit = webBundleEndpointLiteralLimit(
      admission,
      admitted(),
      omittedByCount,
      byteDropped,
      omittedByCountExact,
    );
    const actual = jsonValueByteLength(
      {
        ...facts,
        inferences: selected.map((slot) => slot.item),
        ...(limit === undefined ? {} : { endpoint_literal_candidates: limit }),
      } as unknown as JsonValue,
      resultBudgetBytes,
    );
    if (actual <= resultBudgetBytes || !dropLastLiteral()) break;
    checks += 1;
  }
  return {
    inferences: selected.map((slot) => slot.item),
    admittedCount: admitted(),
    omittedByCount,
    omittedByCountExact,
    omittedByResultBudget: byteDropped,
  };
};

const jsonObject = (value: JsonValue): { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

const serializedBytes = (value: unknown, budget: number): number =>
  jsonValueByteLength(value as JsonValue, budget);
