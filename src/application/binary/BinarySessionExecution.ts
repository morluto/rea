import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import {
  artifactTargetSelectedPath,
  type BinaryTarget,
} from "../../domain/binaryTargetTypes.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { NoBinaryOpenError } from "../../domain/configurationErrors.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { EvidenceSubjectTarget } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisOperation,
  CapabilityDescriptor,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import { offeredOperationAlternatives } from "../OperationAlternatives.js";
import {
  isSnapshotCacheable,
  requestsFreshIndependentDecompile,
  requiresNativeSourceAdmissionBeforeReplay,
} from "./AnalysisSnapshotCache.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";

interface ActiveExecutionBinding {
  readonly target: BinaryTarget;
  readonly client: AnalysisClient;
  readonly profile: AnalysisProfileCommitment | null;
  readonly route: SessionProviderRoute;
}

export interface PreparedSessionExecution {
  readonly active: ActiveExecutionBinding;
  readonly capability: CapabilityDescriptor;
  readonly profile: AnalysisProfileCommitment | undefined;
  readonly cacheable: boolean;
  readonly cached: AnalysisExecution | undefined;
}

interface PrepareSessionExecutionInput {
  readonly active: ActiveExecutionBinding | undefined;
  readonly operation: AnalysisOperation;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly snapshotContext?: ExecutionOptions["snapshotContext"];
  readonly nativeSourceAdmitted: boolean;
  /** Current availability as binary_session reports it, not the declaration. */
  readonly isOperationAvailable: (operation: AnalysisOperation) => boolean;
  readonly isOperationAdvertised:
    | ((operation: AnalysisOperation) => boolean)
    | undefined;
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

/** Recovery for an operation absent from the selected binary route. */
export const undeclaredOperationGuidance = (
  operation: string,
  entryCommentAvailable = false,
): string => {
  const entryComment =
    entryCommentAvailable &&
    (operation === "set_comment" || operation === "set_inline_comment")
      ? `If the address is exactly a function entry and an entry comment is intended, use MCP annotate_native_function with procedure set to that entry and ${operation === "set_comment" ? "comment" : "inline_comment"}, or CLI rea annotate-native-function with the target, entry and ${operation === "set_comment" ? "--comment" : "--inline-comment"}. This edits session metadata, not arbitrary-address comments; whether CLI edits persist after the invocation depends on the provider and selected checkpoint mode. `
      : "";
  return `${entryComment}In MCP, inspect binary_session with detail: "complete" for candidate availability, target support, and capabilities. If a suitable candidate is available, explicitly call open_binary with the same target and its provider_id. In CLI, use rea providers to inspect readiness and capabilities; target support remains unknown until a target is selected. Select an available candidate with --provider and check the result. Switching may discard provider session edits; retained Evidence does not restore them. Candidate availability does not guarantee support for this target.`;
};

/** Resolve capability, profile, and snapshot state before invoking a provider. */
export const prepareSessionExecution = (
  input: PrepareSessionExecutionInput,
): Result<PreparedSessionExecution, AnalysisError> => {
  const {
    active,
    operation,
    parameters,
    nativeSourceAdmitted,
    isOperationAvailable,
    isOperationAdvertised,
    unboundOperationError,
    lookupSnapshot,
  } = input;
  if (active === undefined) return err(new NoBinaryOpenError());
  const capability = active.route.capabilities.get(operation);
  if (capability?.available !== true) {
    const selectionError = unboundOperationError(operation, active.route);
    if (selectionError !== undefined) return err(selectionError);
    const entryCommentAvailable =
      active.route.binding !== null &&
      active.route.capabilities.get("annotate_native_function")?.available ===
        true &&
      active.route.capabilities.get("annotate_native_function")?.provider.id ===
        active.route.binding.identity.id;
    const undeclaredGuidance =
      capability === undefined
        ? undeclaredOperationGuidance(operation, entryCommentAvailable)
        : undefined;
    return err(
      capabilityUnavailableError(
        active.route,
        operation,
        capability,
        (alternative) =>
          isOperationAvailable(alternative) &&
          (isOperationAdvertised?.(alternative) ?? true),
        undeclaredGuidance === undefined
          ? {
              ...(capability?.userMessage === undefined
                ? {}
                : { userMessage: capability.userMessage }),
              ...(capability?.remediation === undefined
                ? {}
                : { remediationAction: capability.remediation }),
            }
          : {
              userMessage: `The selected provider does not declare ${operation}.`,
              fallbackRemediationAction: undeclaredGuidance,
            },
      ),
    );
  }
  if (
    requestsFreshIndependentDecompile(operation, parameters) &&
    capability.independentDecompile !== true
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        capability.provider.id,
        operation,
        "This provider does not declare fresh independent decompilation.",
      ),
    );
  const profile =
    active.profile !== null &&
    capability.provider.id === active.profile.provider.id
      ? active.profile
      : undefined;
  const cacheable =
    profile !== undefined &&
    isSnapshotCacheable(
      operation,
      capability,
      parameters,
      input.snapshotContext,
    );
  const cached =
    cacheable &&
    (!requiresNativeSourceAdmissionBeforeReplay(capability.provider.id) ||
      nativeSourceAdmitted)
      ? lookupSnapshot(active.target, profile, operation, parameters)
      : undefined;
  return ok({ active, capability, profile, cacheable, cached });
};

/**
 * An undeclared operation names the declared alternatives the caller can run
 * now (`isOffered`); otherwise generic advice remains.
 */
const capabilityUnavailableError = (
  route: SessionProviderRoute,
  operation: AnalysisOperation,
  capability: CapabilityDescriptor | undefined,
  isOffered: (alternative: AnalysisOperation) => boolean,
  recovery?: {
    readonly userMessage?: string;
    readonly remediationAction?: string;
    readonly fallbackRemediationAction?: string;
  },
): AnalysisCapabilityUnavailableError => {
  const offered =
    capability === undefined
      ? offeredOperationAlternatives(operation, isOffered)
      : undefined;
  return new AnalysisCapabilityUnavailableError(
    route.binding?.identity.id ?? route.identity.id,
    operation,
    capability?.reason ?? "operation is not declared by this provider",
    {
      ...(recovery?.userMessage === undefined
        ? {}
        : { userMessage: recovery.userMessage }),
      ...(offered === undefined
        ? recovery?.remediationAction === undefined
          ? {}
          : { remediationAction: recovery.remediationAction }
        : {
            alternatives: offered.operations,
            remediationAction: offered.remediation,
          }),
      ...(offered !== undefined ||
      recovery?.fallbackRemediationAction === undefined
        ? {}
        : { fallbackRemediationAction: recovery.fallbackRemediationAction }),
    },
  );
};

/** Attach the selected profile only when the provider identity agrees. */
export const commitExecutionProfile = (
  operation: AnalysisOperation,
  result: Result<AnalysisExecution, AnalysisError>,
  profile: AnalysisProfileCommitment | undefined,
): Result<AnalysisExecution, AnalysisError> => {
  if (!result.ok || profile === undefined) return result;
  const provider = result.value.provider;
  if (
    provider.id !== profile.provider.id ||
    provider.name !== profile.provider.name ||
    provider.version !== profile.provider.version
  )
    return err(
      new ProviderAdapterError(profile.provider.id, `${operation}:profile`),
    );
  return ok({
    ...result.value,
    analysisProfile: structuredClone(profile),
  });
};

/** Bind an execution to the selected target, preserving valid artifact subjects. */
export const bindExecutionTarget = (
  result: Result<AnalysisExecution, AnalysisError>,
  operation: AnalysisOperation,
  target: BinaryTarget,
): Result<AnalysisExecution, AnalysisError> => {
  if (!result.ok) return result;
  const subject: EvidenceSubjectTarget = {
    path: target.path,
    sha256: target.sha256,
    format:
      target.format === "analysis-database"
        ? "analysis-database"
        : target.format,
    ...(target.architecture === undefined
      ? {}
      : { architecture: target.architecture }),
  };
  if (
    result.value.subject !== undefined &&
    result.value.subject !== null &&
    result.value.subject.sha256 !== target.sha256 &&
    !isArtifactBundleSubject(operation, result.value.subject, target)
  )
    return err(
      new ProviderAdapterError(
        result.value.provider.id,
        `${operation}:subject`,
      ),
    );
  return result.value.subject === undefined
    ? ok({ ...result.value, subject })
    : result;
};

const isArtifactBundleSubject = (
  operation: AnalysisOperation,
  subject: EvidenceSubjectTarget,
  target: BinaryTarget,
): boolean =>
  target.bundleInfoPlist !== undefined &&
  (operation === "inventory_artifact" ||
    operation === "inspect_artifact" ||
    operation === "extract_artifact") &&
  subject.path === artifactTargetSelectedPath(target);
