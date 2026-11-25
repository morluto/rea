import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import type { HarmonyAbcAnalysisPort } from "../../ports/harmony/HarmonyAbcAnalysisPort.js";
import {
  harmonyAbcRequestSchema,
  harmonyAbcResultSchemas,
  DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS,
  type HarmonyAbcOperation,
} from "../../domain/harmony/harmonyAbcAnalysis.js";
import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const budgetSchema = z.object({
  analysis_timeout_ms: z.number().int().min(1).exactOptional(),
});

/** Shared CLI/MCP validation and Evidence composition for HarmonyOS .abc files. */
export class HarmonyAbcAnalysisService {
  constructor(readonly provider: HarmonyAbcAnalysisPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Execute an explicit operation and preserve its producing identity. */
  async execute(
    operation: HarmonyAbcOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(cancelledBy(operation, options.signal));
    const parsed = harmonyAbcRequestSchema.safeParse({ operation, input });
    if (!parsed.success)
      return err(
        new AnalysisInputError(
          operation,
          { cause: parsed.error },
          projectInputIssues(parsed.error.issues, { operation, input }),
        ),
      );
    const executed = await this.provider.execute(parsed.data, options);
    if (!executed.ok) return executed;
    const execution = executed.value;
    if (execution.subject == null)
      return err(
        new AnalysisOutputError(
          operation,
          "HarmonyOS Ark bytecode execution did not bind its source artifact",
        ),
      );
    // Providers own normalized facts. Check only fresh execution metadata here,
    // without reparsing potentially large decompilation content.
    const budget = budgetSchema.safeParse(execution.result);
    if (
      !budget.success ||
      budget.data.analysis_timeout_ms !==
        (parsed.data.input.analysis_timeout_ms ??
          DEFAULT_HARMONY_ABC_ANALYSIS_TIMEOUT_MS)
    )
      return err(
        new AnalysisOutputError(
          operation,
          "HarmonyOS Ark bytecode execution did not retain its selected analysis budget",
        ),
      );
    if (
      harmonyAbcResultSchemas[operation].safeParse(execution.result).success !==
      true
    )
      return err(
        new AnalysisOutputError(
          operation,
          "HarmonyOS Ark bytecode execution produced a result outside its declared contract",
        ),
      );
    return completeProviderEvidence(
      createAnalysisExecutionEvidence(
        operation,
        parsed.data.input,
        execution,
        "observed",
      ),
      options?.signal,
    );
  }
}
