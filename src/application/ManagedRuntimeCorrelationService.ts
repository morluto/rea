import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  managedRuntimeCorrelationInputSchema,
  planManagedRuntimeCorrelation,
  type ManagedRuntimeCorrelationInput,
} from "../domain/managedRuntimeCorrelation.js";
import { err, ok, type Result } from "../domain/result.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";
import { digestJson } from "./JavaScriptReplayPlanning.js";

const OPERATION = "plan_managed_runtime_correlation" as const;

export interface ManagedRuntimePolicy {
  readonly enabled: boolean;
  readonly roots: readonly string[];
  readonly executablePath: string;
}

export interface ManagedRuntimeCorrelationDependencies {
  readonly policy: ManagedRuntimePolicy;
  readonly authority: PermissionAuthority | undefined;
}

/** Create a separately authorized, non-executing managed runtime plan Evidence. */
export const planManagedRuntimeCorrelationEvidence = async (
  dependencies: ManagedRuntimeCorrelationDependencies,
  rawInput: unknown,
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = managedRuntimeCorrelationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  if (!dependencies.policy.enabled)
    return err(
      new AnalysisCapabilityUnavailableError(
        MANAGED_WORKFLOW_PROVIDER.id,
        OPERATION,
        "managed runtime correlation is disabled; configure exact roots and runtime executable before enabling it",
      ),
    );
  if (dependencies.authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        MANAGED_WORKFLOW_PROVIDER.id,
        OPERATION,
        "managed runtime permission policy is not configured",
      ),
    );
  let staticEvidence: Evidence;
  let artifactPath: string;
  try {
    staticEvidence = parseEvidence(parsed.data.static_members);
    artifactPath = artifactPathFor(staticEvidence);
  } catch (cause: unknown) {
    return err(new AnalysisInputError(OPERATION, { cause }));
  }
  const authorized = await dependencies.authority.explain(
    {
      capability: "managed_runtime",
      roots: [artifactPath],
      executables: [dependencies.policy.executablePath],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: operationIdentity(parsed.data, staticEvidence),
    },
    "read",
    { restartRequired: true },
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  try {
    const result = planManagedRuntimeCorrelation(
      parsed.data,
      dependencies.policy.executablePath,
      authorized.value.grant_id,
    );
    return ok(
      createEvidence(
        {
          path: result.static_observation.artifact_path,
          sha256: result.static_observation.artifact_sha256,
          format: "pe",
        },
        MANAGED_WORKFLOW_PROVIDER,
        {
          predicateType: "rea.managed-runtime-correlation-plan/v1",
          operation: OPERATION,
          parameters: {
            static_members_evidence_id: staticEvidence.evidence_id,
            method: jsonValueSchema.parse(parsed.data.method),
            requested_effect: parsed.data.requested_effect,
            host: jsonValueSchema.parse(parsed.data.host),
            bounds: jsonValueSchema.parse(parsed.data.bounds),
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

const artifactPathFor = (evidence: Evidence): string => {
  const result = evidence.normalized_result;
  if (
    typeof result === "object" &&
    result !== null &&
    "artifact" in result &&
    typeof result.artifact === "object" &&
    result.artifact !== null &&
    "path" in result.artifact &&
    typeof result.artifact.path === "string"
  )
    return result.artifact.path;
  throw new AnalysisInputError(OPERATION, {
    cause: new TypeError(
      "Managed member Evidence does not expose an artifact path",
    ),
  });
};

const operationIdentity = (
  input: ManagedRuntimeCorrelationInput,
  evidence: Evidence,
): string =>
  `${OPERATION}:${digestJson({
    evidence_id: evidence.evidence_id,
    method: input.method,
    requested_effect: input.requested_effect,
    host: input.host,
    bounds: input.bounds,
  })}`;
