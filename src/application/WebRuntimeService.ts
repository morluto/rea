import { z } from "zod";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { WebRuntimePort } from "./WebRuntimePort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  observeWebExecutionInputSchema,
  webExecutionSchema,
} from "../domain/webExecution.js";
import {
  inspectWebEventListenersInputSchema,
  webEventListenersSchema,
} from "../domain/webEventListeners.js";

/** Shared public workflows keep instrumentation and listener inspection independently selectable. */
export class WebRuntimeService {
  constructor(readonly provider: WebRuntimePort) {}

  /** Observe externally triggered execution; selection authorizes the declared instrumentation. */
  async observe(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "observe_web_execution";
    const parsed = parseInput(
      observeWebExecutionInputSchema,
      rawInput,
      operation,
      options,
    );
    if (!parsed.ok) return parsed;
    const result = await this.provider.observeExecution(parsed.value, options);
    if (!result.ok) return result;
    const verified = webExecutionSchema.safeParse(result.value);
    if (!verified.success)
      return err(new AnalysisOutputError(operation, verified.error.message));
    if (
      verified.data.target.target_id !== parsed.value.target_id ||
      verified.data.window.requested_ms !== parsed.value.observation_ms
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Provider changed the selected target or requested window.",
        ),
      );
    return this.evidence(operation, parsed.value, verified.data, options);
  }

  /** Inspect one selected node's listener declarations without dispatching an event. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "inspect_web_event_listeners";
    const parsed = parseInput(
      inspectWebEventListenersInputSchema,
      rawInput,
      operation,
      options,
    );
    if (!parsed.ok) return parsed;
    const result = await this.provider.inspectEventListeners(
      parsed.value,
      options,
    );
    if (!result.ok) return result;
    const verified = webEventListenersSchema.safeParse(result.value);
    if (!verified.success)
      return err(new AnalysisOutputError(operation, verified.error.message));
    if (
      verified.data.target.target_id !== parsed.value.target_id ||
      verified.data.selected_node.selector !== parsed.value.selector
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Provider changed the selected target or node selector.",
        ),
      );
    return this.evidence(operation, parsed.value, verified.data, options);
  }

  private evidence(
    operation: string,
    input:
      | z.infer<typeof observeWebExecutionInputSchema>
      | z.infer<typeof inspectWebEventListenersInputSchema>,
    result:
      | z.infer<typeof webExecutionSchema>
      | z.infer<typeof webEventListenersSchema>,
    options?: ExecutionOptions,
  ): Result<Evidence, AnalysisError> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    if (
      input.allowed_origins.length > 0 &&
      !input.allowed_origins.includes(result.target.origin)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "Provider returned a document outside the selected origin scope.",
        ),
      );
    return ok(
      createEvidence(undefined, this.provider.identity(), {
        predicateType: `rea.${operation.replaceAll("_", "-")}`,
        operation,
        parameters: jsonObjectSchema.parse(input),
        result: jsonValueSchema.parse(result),
        confidence: "observed",
        authority: "external-service",
        limitations: result.limitations,
      }),
    );
  }
}

const parseInput = <T>(
  schema: z.ZodType<T>,
  rawInput: unknown,
  operation: string,
  options: ExecutionOptions | undefined,
): Result<T, AnalysisError> => {
  if (options?.signal?.aborted)
    return err(new AnalysisCancelledError(operation));
  const parsed = schema.safeParse(rawInput);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new AnalysisInputError(
          operation,
          { cause: parsed.error },
          projectInputIssues(parsed.error.issues, rawInput),
        ),
      );
};
