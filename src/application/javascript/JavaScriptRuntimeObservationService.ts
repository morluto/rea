import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JavaScriptRuntimeObservationPort } from "./JavaScriptRuntimeObservationPort.js";
import { createJavaScriptRuntimeObservationEvidence } from "./JavaScriptRuntimeObservationEvidence.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  ListJavaScriptRuntimeTargetsInput,
  ObserveJavaScriptRuntimeInput,
} from "../../domain/javascript/javascriptRuntimeObservation.js";
import { err, ok, type Result } from "../../domain/result.js";

/** List targets exposed by the explicitly selected loopback Inspector. */
export const listJavaScriptRuntimeTargets = async (
  provider: JavaScriptRuntimeObservationPort | undefined,
  input: ListJavaScriptRuntimeTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "list_javascript_runtime_targets");
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? ok(
        createJavaScriptRuntimeObservationEvidence(
          "list_javascript_runtime_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Observe one attach-only Inspector target selected by the request. */
export const observeJavaScriptRuntime = async (
  provider: JavaScriptRuntimeObservationPort | undefined,
  input: ObserveJavaScriptRuntimeInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = requireProvider(provider, "observe_javascript_runtime");
  if (!ready.ok) return ready;
  const result = await ready.value.observe(input, options);
  if (!result.ok) return result;
  if (options.signal?.aborted === true)
    return err(new AnalysisCancelledError("observe_javascript_runtime"));
  return ok(
    createJavaScriptRuntimeObservationEvidence(
      "observe_javascript_runtime",
      input,
      result.value,
      ready.value.identity(),
    ),
  );
};

const requireProvider = (
  provider: JavaScriptRuntimeObservationPort | undefined,
  operation: "list_javascript_runtime_targets" | "observe_javascript_runtime",
): Result<JavaScriptRuntimeObservationPort, AnalysisError> =>
  provider === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-v8-inspector",
          operation,
          "V8 Inspector observation provider is not configured",
        ),
      )
    : ok(provider);
