import type { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { Evidence } from "../domain/evidence.js";
import { err, type Result } from "../domain/result.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../ports/AnalysisProvider.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import {
  projectRetainedAnalysis,
  requireAnalysisViewRetention,
  type AnalysisViewRetention,
} from "./analysisView/AnalysisViewService.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";

/** Provider boundary for a single-operation artifact inspection. */
export interface ArtifactInspectionPort<TParameters, TReport> {
  readonly identity: ProviderIdentity;
  inspect(
    input: TParameters,
    options?: ExecutionOptions,
  ): Promise<Result<TReport, AnalysisError>>;
}

/** Shared single-operation artifact inspection runner for CLI, MCP, and SDK services. */
export interface ArtifactInspectionSpec<TInput, TParameters, TReport> {
  readonly operation: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TReport>;
  readonly provider: ArtifactInspectionPort<TParameters, TReport>;
  readonly invalidOutputMessage: string;
  readonly toParameters: (input: TInput) => TParameters;
  readonly validateReport: (
    report: TReport,
    parameters: TParameters,
  ) => boolean;
  readonly buildEvidence: (
    report: TReport,
    identity: ProviderIdentity,
    parameters: TParameters,
  ) => Evidence;
  readonly selectRetainedView?: (
    input: TInput,
  ) => AnalysisViewRequest | undefined;
}

const NO_RETENTION: AnalysisViewRetention = {
  evidenceById: undefined,
  recordEvidence: undefined,
};

/**
 * Parse caller input, enforce optional retained-view session ownership, run
 * the provider, validate its report shape and invariants, wrap in Evidence,
 * and apply late-abort and optional retained-view projection once.
 */
export const executeArtifactInspection = async <TInput, TParameters, TReport>(
  spec: ArtifactInspectionSpec<TInput, TParameters, TReport>,
  rawInput: unknown,
  options?: ExecutionOptions,
  retention: AnalysisViewRetention = NO_RETENTION,
): Promise<Result<Evidence, AnalysisError>> => {
  const input = parseAnalysisInput(
    spec.operation,
    rawInput,
    spec.inputSchema,
    options?.signal,
  );
  if (!input.ok) return input;
  const retainedView = spec.selectRetainedView?.(input.value);
  if (retainedView !== undefined) {
    const ready = requireAnalysisViewRetention(spec.operation, retention);
    if (!ready.ok) return ready;
  }
  const parameters = spec.toParameters(input.value);
  const inspected = await spec.provider.inspect(parameters, options);
  if (!inspected.ok) return inspected;
  const checked = spec.outputSchema.safeParse(inspected.value);
  if (!checked.success || !spec.validateReport(checked.data, parameters))
    return err(
      new AnalysisOutputError(spec.operation, spec.invalidOutputMessage),
    );
  const completed = completeProviderEvidence(
    spec.buildEvidence(checked.data, spec.provider.identity, parameters),
    options?.signal,
  );
  if (!completed.ok || retainedView === undefined) return completed;
  return projectRetainedAnalysis(completed.value, retention, retainedView);
};
