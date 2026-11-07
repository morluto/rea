import { z } from "zod";
import type { InvestigationStatistics } from "../../domain/investigationLifecycle.js";
import { artifactTargetRefusal } from "../../domain/apple/artifactTargetApplicability.js";
import { targetApplicabilityRefusal } from "../../domain/targetApplicability.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { ResolvedAppBundleResourceRoot } from "../AppBundleExecutable.js";
import { binaryTargetSummary } from "./BinaryTargetSummary.js";
import { jsonObjectSchema, type JsonValue } from "../../domain/jsonValue.js";
import type { ProviderOperationHealth } from "../../domain/providerOperationHealth.js";
import type {
  CapabilityDescriptor,
  ProviderIdentity,
  ProviderRequestActivitySnapshot,
  ProviderRuntimeLineageSnapshot,
} from "../AnalysisProvider.js";
import {
  PROVIDER_EFFECT_NAMES,
  providerCapabilitySet,
  analysisProviderCandidate,
  analysisProviderCandidateSummary,
  type ProviderCapabilitySet,
} from "../../contracts/toolOutputSchemaPrimitives.js";
import type {
  SessionProviderRoute,
  SessionProviderRouter,
} from "./SessionProviderRouter.js";
import {
  operationCandidates,
  operationRequirementsView,
  providerStateSummary,
  resolveOperationRequirements,
} from "./OperationCandidates.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { BinarySessionDetail } from "../../contracts/sessionStatusContract.js";
import type { AnalysisCleanupRetry } from "../../domain/analysisErrorRecovery.js";

interface BinarySessionStatusInput {
  readonly investigation: InvestigationStatistics;
  readonly target: BinaryTarget | undefined;
  readonly bundleResourceRoot?: ResolvedAppBundleResourceRoot;
  readonly resourceCapabilities?: readonly CapabilityDescriptor[];
  readonly route: SessionProviderRoute;
  readonly router: Pick<
    SessionProviderRouter,
    "candidateStatuses" | "deepOperations"
  >;
  readonly runtimeUnavailability: ReadonlyMap<
    string,
    { readonly reason: string }
  >;
  readonly runId: string | undefined;
  readonly runtimeLineageSnapshots: readonly ProviderRuntimeLineageSnapshot[];
  readonly requestActivitySnapshots: readonly ProviderRequestActivitySnapshot[];
  readonly providerOperationHealth?: ProviderOperationHealth | null;
  readonly cleanupPending?: boolean;
  readonly cleanupRetry?: AnalysisCleanupRetry;
  readonly detail?: BinarySessionDetail;
  /** Tool name; required by, and only accepted with, the operation view. */
  readonly operation?: string;
  readonly signal?: AbortSignal;
}

/** Project internal provider routing state into the caller-visible session status. */
export const binarySessionStatus = async ({
  investigation,
  target,
  bundleResourceRoot,
  resourceCapabilities = [],
  route,
  router,
  runtimeUnavailability,
  runId,
  runtimeLineageSnapshots,
  requestActivitySnapshots,
  providerOperationHealth,
  cleanupPending = false,
  cleanupRetry,
  detail = "complete",
  operation,
  signal,
}: BinarySessionStatusInput): Promise<JsonValue> => {
  // Validate the view before any candidate discovery runs.
  if ((detail === "operation") !== (operation !== undefined))
    throw new AnalysisInputError("binary_session", {
      userMessage:
        'operation is required with detail: "operation" and is only accepted with it.',
    });
  const operationRequirements =
    operation === undefined
      ? undefined
      : resolveOperationRequirements(operation, router.deepOperations());
  if (operationRequirements !== undefined && !operationRequirements.ok)
    throw operationRequirements.error;
  const routeCapabilities = (
    bundleResourceRoot === undefined
      ? [...route.capabilities.values()]
      : [...resourceCapabilities]
  )
    .filter(({ operation }) => operation !== "inventory_artifact")
    .sort((left, right) =>
      compareUnicodeCodePoints(left.operation, right.operation),
    )
    .map((descriptor) => {
      const targetRefusal =
        target === undefined
          ? undefined
          : descriptor.targetApplicability === undefined
            ? artifactTargetRefusal(descriptor.operation, target)
            : targetApplicabilityRefusal(
                descriptor.targetApplicability,
                target,
              );
      if (targetRefusal !== undefined && descriptor.available)
        return {
          ...descriptor,
          available: false as const,
          availabilityCode: targetRefusal.code,
          reason: targetRefusal.reason,
        };
      const unavailable = runtimeUnavailability.get(descriptor.operation);
      return unavailable === undefined
        ? descriptor
        : runtimeUnavailable(descriptor, unavailable.reason);
    });
  const capabilities = providerCapabilitySets(routeCapabilities);
  const analysisProviderBinding =
    bundleResourceRoot !== undefined
      ? null
      : route.binding === null
        ? null
        : {
            provider: providerSummary(route.binding.identity),
            selection_source: route.binding.selectionSource,
            analysis_profile: structuredClone(route.binding.profile),
            ...(route.binding.releaseVerification === undefined
              ? {}
              : {
                  release_verification: structuredClone(
                    route.binding.releaseVerification,
                  ),
                }),
          };
  const candidateStatuses = await sessionCandidateStatuses({
    resourceOnly: bundleResourceRoot !== undefined,
    operationView: operationRequirements !== undefined,
    route,
    router,
    signal,
  });
  // The operation view replaces the candidate list with per-operation facts
  // derived from the same candidate statuses.
  const candidateFacts =
    operationRequirements !== undefined && operation !== undefined
      ? {
          operation,
          operation_requirements: operationRequirementsView(
            operationRequirements.value,
          ),
          operation_candidates: operationCandidates(
            candidateStatuses,
            operationRequirements.value,
          ),
        }
      : {
          analysis_provider_candidates: projectCandidates(
            candidateStatuses,
            detail === "summary" ? "summary" : "complete",
          ),
        };
  const common = {
    investigation,
    cleanup_pending: cleanupPending,
    ...(cleanupRetry === undefined
      ? {}
      : { cleanup_retry: { ...cleanupRetry } }),
    capabilities,
    analysis_provider_binding: analysisProviderBinding,
    ...candidateFacts,
    analysis_run:
      runId === undefined
        ? null
        : {
            run_id: runId,
            process_lineage: processLineageStatus(runtimeLineageSnapshots),
          },
    analysis_activity: requestActivityStatus(requestActivitySnapshots),
    provider_operation_health: providerOperationHealthStatus(
      providerOperationHealth,
    ),
  };
  return target === undefined
    ? bundleResourceRoot === undefined
      ? { open: false, ...common }
      : {
          open: true,
          ...common,
          session_kind: "bundle_resources",
          resource_root: {
            caller_path: bundleResourceRoot.callerPath,
            canonical_path: bundleResourceRoot.canonicalPath,
            info_plist_path: bundleResourceRoot.infoPlistPath,
            layout: bundleResourceRoot.layout,
            executable_sha256: bundleResourceRoot.executableSha256,
          },
        }
    : {
        open: true,
        ...common,
        ...binaryTargetSummary(target),
      };
};

/**
 * A resource-only session has no binary route, so summary and complete keep
 * their empty candidate list. The operation view still answers its question
 * from target-free candidate statuses, whose target support stays unknown.
 */
const sessionCandidateStatuses = async ({
  resourceOnly,
  operationView,
  route,
  router,
  signal,
}: {
  readonly resourceOnly: boolean;
  readonly operationView: boolean;
  readonly route: SessionProviderRoute;
  readonly router: Pick<SessionProviderRouter, "candidateStatuses">;
  readonly signal: AbortSignal | undefined;
}): Promise<readonly AnalysisProviderCandidateStatus[]> =>
  resourceOnly && !operationView ? [] : router.candidateStatuses(route, signal);

/** Summary keeps each candidate's status facts; complete adds diagnostics and capability sets. */
const projectCandidates = (
  candidates: readonly AnalysisProviderCandidateStatus[],
  detail: "summary" | "complete",
) =>
  candidates.map((candidate) =>
    detail === "summary"
      ? {
          provider: providerSummary(candidate.provider),
          availability: providerStateSummary(candidate.availability),
          target_support: providerStateSummary(candidate.targetSupport),
          selected: candidate.selected,
        }
      : {
          provider: providerSummary(candidate.provider),
          availability: structuredClone(candidate.availability),
          target_support: structuredClone(candidate.targetSupport),
          selected: candidate.selected,
          capabilities: providerCapabilitySets(
            candidate.capabilities
              .slice()
              .filter(({ operation }) => operation !== "inventory_artifact")
              .sort((left, right) =>
                compareUnicodeCodePoints(left.operation, right.operation),
              ),
          ),
        },
  );

/** A runtime observation replaces the declared state and its repair instruction. */
const runtimeUnavailable = (
  descriptor: CapabilityDescriptor,
  reason: string,
): CapabilityDescriptor & { readonly runtimeUnavailable?: true } => {
  if (descriptor.available) {
    const { availabilityCode: _available, ...declared } = descriptor;
    return { ...declared, available: false, reason, runtimeUnavailable: true };
  }
  const { remediation: _superseded, ...declared } = descriptor;
  return { ...declared, reason };
};

/** Capability surfaces a registration may narrow without hiding provider facts. */
const advertisedCapabilitySurfaces = z.object({
  capabilities: z.array(providerCapabilitySet),
  // The operation view carries operation_candidates instead. Their
  // declarations stay unrestricted: they are the requested tool's own
  // provider prerequisites, which a composed tool needs even when the
  // registration hides the direct tools.
  analysis_provider_candidates: z
    .array(
      z.union([analysisProviderCandidate, analysisProviderCandidateSummary]),
    )
    .optional(),
});

/**
 * Restrict a session status report to operations whose tools the caller
 * advertises. Availability must already be computed from the complete status:
 * composed tools still depend on direct operations this projection hides.
 */
export const restrictAdvertisedCapabilities = (
  status: unknown,
  isOperationAdvertised: (operation: string) => boolean,
): Readonly<Record<string, JsonValue>> => {
  const object = jsonObjectSchema.parse(status);
  const { capabilities, analysis_provider_candidates } =
    advertisedCapabilitySurfaces.parse(object);
  return jsonObjectSchema.parse({
    ...object,
    capabilities: restrictCapabilitySets(capabilities, isOperationAdvertised),
    ...(analysis_provider_candidates === undefined
      ? {}
      : {
          analysis_provider_candidates: analysis_provider_candidates.map(
            (candidate) => ({
              ...candidate,
              ...("capabilities" in candidate
                ? {
                    capabilities: restrictCapabilitySets(
                      candidate.capabilities,
                      isOperationAdvertised,
                    ),
                  }
                : {}),
            }),
          ),
        }),
  });
};

const restrictCapabilitySets = (
  sets: readonly ProviderCapabilitySet[],
  isOperationAdvertised: (operation: string) => boolean,
): ProviderCapabilitySet[] =>
  sets.flatMap((set) => {
    const groups = set.groups.flatMap((group) => {
      const operations = group.operations.filter(isOperationAdvertised);
      return operations.length === 0 ? [] : [{ ...group, operations }];
    });
    return groups.length === 0 ? [] : [{ ...set, groups }];
  });

const requestActivityStatus = (
  snapshots: readonly ProviderRequestActivitySnapshot[],
) => {
  const providers = snapshots
    .slice()
    .sort((left, right) =>
      compareUnicodeCodePoints(left.provider.id, right.provider.id),
    )
    .map(({ provider, active, queuedRequests }) => ({
      provider: providerSummary(provider),
      active:
        active === null
          ? null
          : {
              request_id: active.requestId,
              operation: active.operation,
              elapsed_ms: active.elapsedMs,
              caller_state: active.callerState,
            },
      queued_requests: queuedRequests,
    }));
  const active = snapshots.flatMap((snapshot) =>
    snapshot.active === null ? [] : [snapshot.active],
  );
  return {
    status:
      snapshots.length === 0
        ? "not_observed"
        : active.length > 0
          ? "busy"
          : "idle",
    providers,
  };
};

const providerSummary = ({
  id,
  name,
  version,
}: {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
}) => ({ id, name, version });

const processLineageStatus = (
  snapshots: readonly ProviderRuntimeLineageSnapshot[],
) =>
  snapshots.length === 0
    ? { status: "not_observed" }
    : {
        status: "snapshots",
        snapshots: snapshots
          .slice()
          .sort((left, right) =>
            compareUnicodeCodePoints(left.provider.id, right.provider.id),
          )
          .map(({ provider, observation }) => ({
            provider: providerSummary(provider),
            observation:
              observation.status === "unavailable"
                ? {
                    status: observation.status,
                    observed_at: observation.observedAt,
                    launcher_pid: observation.launcherPid,
                    process_group_id: observation.processGroupId,
                    reason: observation.reason,
                  }
                : {
                    status: observation.status,
                    observed_at: observation.observedAt,
                    launcher_pid: observation.lineage.launcherPid,
                    launcher_parent_pid: observation.lineage.launcherParentPid,
                    process_group_id: observation.lineage.processGroupId,
                    descendants: observation.lineage.descendants.map(
                      ({ pid, parentPid, processGroupId }) => ({
                        pid,
                        parent_pid: parentPid,
                        process_group_id: processGroupId,
                      }),
                    ),
                  },
          })),
      };

type CapabilityEffectName = (typeof PROVIDER_EFFECT_NAMES)[number];
type CapabilityAvailabilityCode = Exclude<
  CapabilityDescriptor["availabilityCode"],
  undefined
>;
// Wire capability projection also covers target-free operations outside binary routing.
type CapabilityProjection = Omit<
  CapabilityDescriptor,
  "operation" | "available" | "reason"
> & { readonly operation: string; readonly runtimeUnavailable?: true } & (
    | { readonly available: true; readonly reason: null }
    | {
        readonly available: false;
        readonly reason: string;
        readonly remediation?: string;
      }
  );
type ProviderCapabilityGroup = ProviderCapabilitySet["groups"][number];

/** Group inline capability facts without merging distinct providers or states. */
/** Project provider descriptors once for binary and target-free status consumers. */
export const providerCapabilitySets = (
  descriptors: readonly CapabilityProjection[],
): ProviderCapabilitySet[] => {
  const providers = new Map<
    string,
    {
      readonly identity: ProviderIdentity;
      readonly descriptors: CapabilityProjection[];
    }
  >();
  for (const descriptor of descriptors) {
    const key = JSON.stringify([
      descriptor.provider.id,
      descriptor.provider.name,
      descriptor.provider.version,
    ]);
    const provider = providers.get(key);
    if (provider === undefined)
      providers.set(key, {
        identity: descriptor.provider,
        descriptors: [descriptor],
      });
    else provider.descriptors.push(descriptor);
  }
  return [...providers.values()].map(({ identity, descriptors: owned }) => {
    const sharedLimitations = commonLimitationsPrefix(owned);
    const groups = new Map<string, ProviderCapabilityGroup>();
    for (const descriptor of owned) {
      const effects = enabledCapabilityEffects(descriptor);
      const limitations = descriptor.limitations.slice(
        sharedLimitations.length,
      );
      const availabilityCode: CapabilityAvailabilityCode | null =
        descriptor.availabilityCode ?? null;
      const status = descriptor.available
        ? {
            available: true as const,
            reason: null,
            availability_code: null,
          }
        : {
            available: false as const,
            reason: descriptor.reason,
            availability_code: availabilityCode,
            ...(descriptor.runtimeUnavailable === true
              ? { runtime_unavailable: true as const }
              : {}),
            ...(descriptor.remediation === undefined
              ? {}
              : { remediation: descriptor.remediation }),
          };
      const key = JSON.stringify([
        effects,
        limitations,
        descriptor.nativeValueFlow ?? null,
        descriptor.independentDecompile ?? null,
        status.available,
        status.reason,
        status.availability_code,
        status.available ? null : (status.runtime_unavailable ?? null),
        status.available ? null : (status.remediation ?? null),
      ]);
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          operations: [descriptor.operation],
          effects,
          limitations,
          ...(descriptor.nativeValueFlow === undefined
            ? {}
            : { native_value_flow: descriptor.nativeValueFlow }),
          ...(descriptor.independentDecompile === undefined
            ? {}
            : { independent_decompile: descriptor.independentDecompile }),
          ...status,
        });
      else group.operations.push(descriptor.operation);
    }
    return {
      provider: providerSummary(identity),
      shared_limitations: sharedLimitations,
      groups: [...groups.values()],
    };
  });
};

const commonLimitationsPrefix = (
  descriptors: readonly CapabilityProjection[],
): string[] => {
  const first = descriptors[0]?.limitations;
  if (first === undefined) return [];
  let length = first.length;
  for (const descriptor of descriptors.slice(1)) {
    length = Math.min(length, descriptor.limitations.length);
    let index = 0;
    while (index < length && first[index] === descriptor.limitations[index])
      index++;
    length = index;
  }
  return first.slice(0, length);
};

const enabledCapabilityEffects = (
  descriptor: CapabilityProjection,
): CapabilityEffectName[] => {
  const effectValues = {
    mutates_artifact: descriptor.effects.mutatesArtifact,
    launches_process: descriptor.effects.launchesProcess,
    may_show_ui: descriptor.effects.mayShowUi,
    may_access_network: descriptor.effects.mayAccessNetwork,
    may_write_filesystem: descriptor.effects.mayWriteFilesystem,
    changes_permissions: descriptor.effects.changesPermissions,
    requires_root: descriptor.effects.requiresRoot,
  } satisfies Record<CapabilityEffectName, boolean>;
  return PROVIDER_EFFECT_NAMES.filter((name) => effectValues[name]);
};

const providerOperationHealthStatus = (
  health: ProviderOperationHealth | null | undefined,
): JsonValue => {
  if (health === undefined || health === null) return null;
  return {
    state: health.state,
    stage: health.stage,
    retry_action: health.retryAction,
    exit_code: health.exitCode,
    requests: health.requests.map((request) => ({
      request_id: request.requestId,
      operation: request.operation,
      stage: request.stage,
    })),
  };
};
