import { projectPermissionFailure } from "./PermissionFailure.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { JavaScriptRuntimeObservationPort } from "./JavaScriptRuntimeObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { createJavaScriptRuntimeObservationEvidence } from "./JavaScriptRuntimeObservationEvidence.js";
import type { Evidence } from "../domain/evidence.js";
import {
  AnalysisCapabilityUnavailableError,
  type AnalysisError,
} from "../domain/errors.js";
import type {
  ListJavaScriptRuntimeTargetsInput,
  ObserveJavaScriptRuntimeInput,
} from "../domain/javascriptRuntimeObservation.js";
import { err, ok, type Result } from "../domain/result.js";

/** Authorize and list attachable Node/Electron Inspector targets. */
export const listJavaScriptRuntimeTargets = async (
  provider: JavaScriptRuntimeObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListJavaScriptRuntimeTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    provider,
    authority,
    input,
    "list_javascript_runtime_targets",
  );
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

/** Authorize one bounded attach-only Inspector observation. */
export const observeJavaScriptRuntime = async (
  provider: JavaScriptRuntimeObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ObserveJavaScriptRuntimeInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    provider,
    authority,
    input,
    "observe_javascript_runtime",
  );
  if (!ready.ok) return ready;
  const result = await ready.value.observe(input, options);
  return result.ok
    ? ok(
        createJavaScriptRuntimeObservationEvidence(
          "observe_javascript_runtime",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

const prepare = async (
  provider: JavaScriptRuntimeObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListJavaScriptRuntimeTargetsInput | ObserveJavaScriptRuntimeInput,
  operation: "list_javascript_runtime_targets" | "observe_javascript_runtime",
): Promise<Result<JavaScriptRuntimeObservationPort, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-v8-inspector",
        operation,
        "V8 Inspector observation permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "v8_inspector_observe",
      roots: input.allowed_file_roots,
      executables: [],
      environment_names: [],
      origins: [input.inspector_endpoint, ...input.allowed_origins],
      network: "loopback",
      mount: false,
      operation_identity: `${operation}:${"target_id" in input ? input.target_id : input.inspector_endpoint}`,
    },
    "read",
  );
  if (!authorized.ok) return err(projectPermissionFailure(authorized.error));
  return provider === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-v8-inspector",
          operation,
          "V8 Inspector observation provider is not configured",
        ),
      )
    : ok(provider);
};
