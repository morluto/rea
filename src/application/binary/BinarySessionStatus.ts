import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { binaryTargetSummary } from "./BinaryTargetSummary.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { ProviderOperationHealth } from "../../domain/providerOperationHealth.js";
import type {
  CapabilityDescriptor,
  ProviderIdentity,
  ProviderRequestActivitySnapshot,
  ProviderRuntimeLineageSnapshot,
} from "../AnalysisProvider.js";
import {
  PROVIDER_EFFECT_NAMES,
  type ProviderCapabilitySet,
} from "../../contracts/toolOutputSchemaPrimitives.js";
import type {
  SessionProviderRoute,
  SessionProviderRouter,
} from "./SessionProviderRouter.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";

interface BinarySessionStatusInput {
  readonly target: BinaryTarget | undefined;
  readonly route: SessionProviderRoute;
  readonly router: SessionProviderRouter;
  readonly runtimeUnavailability: ReadonlyMap<
    string,
    { readonly reason: string }
  >;
  readonly runId: string | undefined;
  readonly runtimeLineageSnapshots: readonly ProviderRuntimeLineageSnapshot[];
  readonly requestActivitySnapshots: readonly ProviderRequestActivitySnapshot[];
  readonly providerOperationHealth?: ProviderOperationHealth | null;
}

/** Project internal provider routing state into the caller-visible session status. */
export const binarySessionStatus = ({
  target,
  route,
  router,
  runtimeUnavailability,
  runId,
  runtimeLineageSnapshots,
  requestActivitySnapshots,
  providerOperationHealth,
}: BinarySessionStatusInput): JsonValue => {
  const routeCapabilities = [...route.capabilities.values()]
    .filter(({ operation }) => operation !== "inventory_artifact")
    .sort((left, right) =>
      compareUnicodeCodePoints(left.operation, right.operation),
    )
    .map((descriptor) => {
      const unavailable = runtimeUnavailability.get(descriptor.operation);
      return unavailable === undefined
        ? descriptor
        : {
            ...descriptor,
            available: false as const,
            reason: unavailable.reason,
          };
    });
  const capabilities = providerCapabilitySets(routeCapabilities);
  const analysisProviderBinding =
    route.binding === null
      ? null
      : {
          provider: providerSummary(route.binding.identity),
          selection_source: route.binding.selectionSource,
          analysis_profile: structuredClone(route.binding.profile),
        };
  const analysisProviderCandidates = router
    .candidateStatuses(route)
    .map((candidate) => ({
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
    }));
  const common = {
    capabilities,
    analysis_provider_binding: analysisProviderBinding,
    analysis_provider_candidates: analysisProviderCandidates,
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
    ? { open: false, ...common }
    : {
        open: true,
        ...common,
        ...binaryTargetSummary(target),
      };
};

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
> & { readonly operation: string } & (
    | { readonly available: true; readonly reason: null }
    | { readonly available: false; readonly reason: string }
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
          };
      const key = JSON.stringify([
        effects,
        limitations,
        status.available,
        status.reason,
        status.availability_code,
      ]);
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          operations: [descriptor.operation],
          effects,
          limitations,
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
