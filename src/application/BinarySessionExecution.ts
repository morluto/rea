import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  NoBinaryOpenError,
  type AnalysisError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisOperation,
  CapabilityDescriptor,
} from "./AnalysisProvider.js";
import { isSnapshotCacheable } from "./AnalysisSnapshotCache.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";

interface ActiveExecutionBinding {
  readonly target: BinaryTarget;
  readonly client: AnalysisClient;
  readonly profile: AnalysisProfileCommitment | null;
  readonly route: SessionProviderRoute;
}

export interface PreparedSessionExecution {
  readonly active: ActiveExecutionBinding;
  readonly capability: CapabilityDescriptor | undefined;
  readonly profile: AnalysisProfileCommitment | undefined;
  readonly cacheable: boolean;
  readonly cached: AnalysisExecution | undefined;
}

interface PrepareSessionExecutionInput {
  readonly active: ActiveExecutionBinding | undefined;
  readonly operation: AnalysisOperation;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly unboundOperationError: (
    operation: AnalysisOperation,
    route: SessionProviderRoute,
  ) => AnalysisError | undefined;
  readonly lookupSnapshot: (
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
  ) => AnalysisExecution | undefined;
}

/** Resolve capability, profile, and snapshot state before invoking a provider. */
export const prepareSessionExecution = (
  input: PrepareSessionExecutionInput,
): Result<PreparedSessionExecution, AnalysisError> => {
  const {
    active,
    operation,
    parameters,
    unboundOperationError,
    lookupSnapshot,
  } = input;
  if (active === undefined) return err(new NoBinaryOpenError());
  const capability = active.route.capabilities?.get(operation);
  if (
    active.route.capabilities !== undefined &&
    capability?.available !== true
  ) {
    const selectionError = unboundOperationError(operation, active.route);
    if (selectionError !== undefined) return err(selectionError);
    return err(
      new AnalysisCapabilityUnavailableError(
        active.route.binding?.identity.id ?? active.route.identity.id,
        operation,
        capability?.reason ?? "operation is not declared by this provider",
      ),
    );
  }
  const profile =
    active.profile !== null &&
    (capability === undefined ||
      capability.provider.id === active.profile.provider.id)
      ? active.profile
      : undefined;
  const cacheable =
    profile !== undefined &&
    isSnapshotCacheable(operation, capability, parameters);
  const cached = cacheable
    ? lookupSnapshot(active.target, profile, operation, parameters)
    : undefined;
  return ok({ active, capability, profile, cacheable, cached });
};
