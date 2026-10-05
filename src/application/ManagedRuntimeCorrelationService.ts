import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  managedRuntimeCorrelationInputSchema,
  planManagedRuntimeCorrelation,
  type ManagedRuntimeCorrelationInput,
} from "../domain/managedRuntimeCorrelation.js";
import { err, ok, type Result } from "../domain/result.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";

const OPERATION = "plan_managed_runtime_correlation" as const;

/** Configured local runtime executable used when preparing a correlation plan. */
export interface ManagedRuntimeConfiguration {
  readonly executablePath: string | undefined;
}

/** Live managed runtime configuration source, evaluated for each request. */
export interface ManagedRuntimeCorrelationDependencies {
  readonly configuration: () => ManagedRuntimeConfiguration;
}

/** Create a non-executing managed runtime correlation plan Evidence record. */
export const planManagedRuntimeCorrelationEvidence = async (
  dependencies: ManagedRuntimeCorrelationDependencies,
  rawInput: unknown,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = managedRuntimeCorrelationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  return planManagedRuntimeCorrelationEvidenceValidated(
    dependencies,
    parsed.data,
  );
};

/** Plan runtime correlation from input parsed by a trusted adapter. */
export const planManagedRuntimeCorrelationEvidenceValidated = async (
  dependencies: ManagedRuntimeCorrelationDependencies,
  input: ManagedRuntimeCorrelationInput,
): Promise<Result<Evidence, AnalysisError>> => {
  const executablePath =
    dependencies.configuration().executablePath ?? "dotnet";
  try {
    const result = planManagedRuntimeCorrelation(input, executablePath);
    return ok(
      createEvidence(
        {
          path: result.static_observation.artifact_path,
          sha256: result.static_observation.artifact_sha256,
          format: "pe",
        },
        MANAGED_WORKFLOW_PROVIDER,
        {
          predicateType: "rea.managed-runtime-correlation-plan",
          operation: OPERATION,
          parameters: {
            static_members_evidence_id: result.static_observation.evidence_id,
            method: jsonValueSchema.parse(input.method),
            requested_effect: input.requested_effect,
            host: jsonValueSchema.parse(input.host),
            bounds: jsonValueSchema.parse(input.bounds),
          },
          result: jsonValueSchema.parse(result),
          rawResult: null,
          confidence: "derived",
          authority: "analyst-inference",
          environment: null,
          limitations: result.limitations,
          locations: [
            {
              kind: "artifact-path",
              path: result.static_observation.artifact_path,
            },
          ],
          evidenceLinks: result.evidence_links,
        },
      ),
    );
  } catch (cause: unknown) {
    return err(
      cause instanceof TypeError
        ? new AnalysisInputError(OPERATION, { cause })
        : new AnalysisProtocolError(
            "Managed runtime correlation planning produced an invalid result",
            { cause },
          ),
    );
  }
};
