import type { JsonValue } from "./jsonValue.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";
import {
  webBundleEndpointLiteralRecord,
  type WebBundleEndpointLiteralAdmission,
} from "./webBundleEndpointLiteralBudget.js";
import { isLiteralEndpointCandidate } from "./webBundleEndpointLiterals.js";
import type { WebBundleScriptAnalysis } from "./webBundleScriptAnalysis.js";

type AnalyzedWebScript = Extract<
  WebBundleScriptAnalysis,
  { status: "analyzed" }
>;

/**
 * Admit literal path/URL candidates inside the per-script result's actual byte
 * budget. Non-literal facts are never dropped here, and a literal that does not
 * fit is skipped rather than ending the pass, so one oversized literal cannot
 * remove the smaller ones after it. The surviving literals keep their source
 * order. Byte drops are recorded apart from the count-ceiling drops, because
 * raising the setting recovers only the latter.
 */
export const fitWebBundleEndpointLiteralCandidates = (
  result: AnalyzedWebScript,
  resultBudgetBytes: number,
  admission: WebBundleEndpointLiteralAdmission,
): AnalyzedWebScript => {
  const { endpoint_literal_candidates: previous, ...facts } = result;
  if (
    !result.inferences.some((inference) =>
      isLiteralEndpointCandidate(inference),
    )
  )
    return result;
  const omittedByCount = previous?.omitted_by_count ?? 0;
  const omittedByCountExact = previous?.omitted_by_count_exact ?? true;
  const assemble = (literals: readonly number[]): AnalyzedWebScript => {
    const retained = new Set(literals);
    const inferences: AnalyzedWebScript["inferences"] = [];
    let index = 0;
    for (const inference of result.inferences) {
      if (!isLiteralEndpointCandidate(inference)) {
        inferences.push(inference);
        continue;
      }
      if (retained.has(index)) inferences.push(inference);
      index += 1;
    }
    const record = webBundleEndpointLiteralRecord(admission, retained.size, {
      byCount: omittedByCount,
      byCountExact: omittedByCountExact,
      byResultBudget: index - retained.size,
    });
    return (
      record === undefined
        ? { ...facts, inferences }
        : { ...facts, endpoint_literal_candidates: record, inferences }
    ) as AnalyzedWebScript;
  };
  const baseBytes = jsonValueByteLength(
    assemble([]) as unknown as JsonValue,
    resultBudgetBytes,
  );
  // A result that already fits must be returned unchanged: reserving an
  // omission record through `assemble([])` first would drop literals (and,
  // for one short candidate, the record can even be larger than the candidate
  // it replaces), rejecting a result that originally fit.
  if (
    jsonValueByteLength(result as unknown as JsonValue, resultBudgetBytes) <=
    resultBudgetBytes
  )
    return result;
  if (baseBytes > resultBudgetBytes) return assemble([]);
  const kept: number[] = [];
  let used = baseBytes;
  let index = 0;
  // `assemble([])` keeps every non-literal inference, so the array already has
  // elements before the first literal arrives and that literal pays a comma
  // too. Charging it only for later literals lets a literal whose own size
  // exactly fills the remaining space be kept, push the result one byte over,
  // and then be dropped by the exact pass without a smaller literal behind it
  // ever being tried.
  let elements = result.inferences.filter(
    (inference) => !isLiteralEndpointCandidate(inference),
  ).length;
  for (const inference of result.inferences) {
    if (!isLiteralEndpointCandidate(inference)) continue;
    const cost =
      jsonValueByteLength(inference as unknown as JsonValue) +
      (elements > 0 ? 1 : 0);
    // The base measurement already carries the widest omission record, so the
    // pass never has to reserve it again for each literal.
    if (used + cost <= resultBudgetBytes) {
      kept.push(index);
      used += cost;
      elements += 1;
    }
    index += 1;
  }
  let fitted = assemble(kept);
  // One exact pass catches a comma or key the incremental estimate left out.
  while (
    kept.length > 0 &&
    jsonValueByteLength(fitted as unknown as JsonValue, resultBudgetBytes) >
      resultBudgetBytes
  ) {
    kept.pop();
    fitted = assemble(kept);
  }
  return fitted;
};
