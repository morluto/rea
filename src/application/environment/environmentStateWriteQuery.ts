import { validatePinnedQuery } from "../../domain/analysisView/environmentStateWriteStamps.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { iterateUrlQueryParameters } from "../../domain/recordedTransportUrl.js";
import { err, ok, type Result } from "../../domain/result.js";
import { refused, type StateServing } from "./environmentStateAnswer.js";
import { callQuery } from "./environmentStateCallLines.js";
import type { WriteRequest } from "./environmentStateWriteAnswer.js";
import { hasRepeatedQueryArgument } from "./environmentTools.js";

/** Admit a served write against its pinned query, retaining the caller's supplied arguments for response provenance. */
export const admitWriteQuery = (
  serving: StateServing,
  request: WriteRequest,
): Result<WriteRequest, AnalysisError> => {
  const { tool, plan, args } = request;
  const supplied = callQuery(tool, args);
  const observed = new Map<string, string>();
  let repeated = hasRepeatedQueryArgument(tool, args);
  for (const [name, value] of iterateUrlQueryParameters(
    request.observedQuery ?? "",
  )) {
    if (observed.has(name)) repeated = true;
    observed.set(name, value);
  }
  if (repeated)
    return err(
      refused(
        tool,
        "The state write model cannot apply repeated query parameters; the state is unchanged.",
      ),
    );
  const query = validatePinnedQuery(
    serving.source.exchanges.get(plan.exemplar_ordinal ?? -1)?.query,
    // Comparison supplies the raw query as well as translated known arguments.
    // Keep unmodeled parameters visible without replacing those translations.
    new Map([...observed, ...supplied]),
  );
  return query.ok
    ? ok(request)
    : err(refused(tool, `Tool ${tool.name} ${query.error}`));
};
