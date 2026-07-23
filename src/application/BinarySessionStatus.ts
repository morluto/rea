import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  CapabilityDescriptor,
  ProviderRequestActivitySnapshot,
  ProviderRuntimeLineageSnapshot,
} from "./AnalysisProvider.js";
import type {
  SessionProviderRoute,
  SessionProviderRouter,
} from "./SessionProviderRouter.js";

interface BinarySessionStatusInput {
  readonly target: BinaryTarget | undefined;
  readonly route: SessionProviderRoute;
  readonly router: SessionProviderRouter;
  readonly runtimeAvailability: ReadonlyMap<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >;
  readonly runId: string | undefined;
  readonly runtimeLineageSnapshots: readonly ProviderRuntimeLineageSnapshot[];
  readonly requestActivitySnapshots: readonly ProviderRequestActivitySnapshot[];
}

/** Project internal provider routing state into the caller-visible session status. */
export const binarySessionStatus = ({
  target,
  route,
  router,
  runtimeAvailability,
  runId,
  runtimeLineageSnapshots,
  requestActivitySnapshots,
}: BinarySessionStatusInput): JsonValue => {
  const configuredProvider = router.configuredIdentity();
  const provider = providerSummary(configuredProvider);
  const providers = router.providerIdentities(route).map(providerSummary);
  const capabilities = [...(route.capabilities?.values() ?? [])]
    .sort((left, right) => left.operation.localeCompare(right.operation))
    .map((descriptor) => ({
      ...descriptor,
      ...runtimeAvailability.get(descriptor.operation),
    }))
    .map(capabilityStatus);
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
      capabilities: candidate.capabilities
        .slice()
        .sort((left, right) => left.operation.localeCompare(right.operation))
        .map(capabilityStatus),
    }));
  const common = {
    provider,
    providers,
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
  };
  return target === undefined
    ? { open: false, ...common }
    : {
        open: true,
        ...common,
        path: target.path,
        sha256: target.sha256,
        format: target.format,
        kind: target.kind,
        architecture: target.architecture ?? null,
      };
};

const requestActivityStatus = (
  snapshots: readonly ProviderRequestActivitySnapshot[],
) => {
  const providers = snapshots
    .slice()
    .sort((left, right) => left.provider.id.localeCompare(right.provider.id))
    .map(({ provider, active, queuedRequests }) => ({
      provider: providerSummary(provider),
      active:
        active === null
          ? null
          : {
              request_id: active.requestId,
              operation: active.operation,
              elapsed_ms: active.elapsedMs,
              timeout_ms: active.timeoutMs,
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
        : active.some(({ callerState }) => callerState === "timed_out")
          ? "timed_out_busy"
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
            left.provider.id.localeCompare(right.provider.id),
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
                    schema_version: observation.lineage.schemaVersion,
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

const capabilityStatus = (
  descriptor: Omit<CapabilityDescriptor, "available" | "reason"> & {
    readonly available: boolean;
    readonly reason: string | null;
  },
) => ({
  operation: descriptor.operation,
  available: descriptor.available,
  reason: descriptor.reason,
  availability_code: descriptor.availabilityCode ?? null,
  input_contract_version: descriptor.inputContractVersion,
  output_contract_version: descriptor.outputContractVersion,
  pagination: descriptor.pagination,
  exhaustive: descriptor.exhaustive,
  effects: {
    mutates_artifact: descriptor.effects.mutatesArtifact,
    launches_process: descriptor.effects.launchesProcess,
    may_show_ui: descriptor.effects.mayShowUi,
    may_access_network: descriptor.effects.mayAccessNetwork,
    may_write_filesystem: descriptor.effects.mayWriteFilesystem,
    changes_permissions: descriptor.effects.changesPermissions,
    requires_root: descriptor.effects.requiresRoot,
  },
  limits: {
    max_results: descriptor.limits.maxResults,
    max_payload_bytes: descriptor.limits.maxPayloadBytes,
    timeout_ms: descriptor.limits.timeoutMs,
  },
  limitations: [...descriptor.limitations],
});
