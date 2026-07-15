import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  analysisProfilesEqual,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import {
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  AnalysisCancelledError,
  NoBinaryOpenError,
  ProviderAdapterError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Evidence } from "../domain/evidence.js";
import { createEvidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { evidenceBundleForTarget } from "../domain/evidenceBundle.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisClientFactory,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisOperationPort,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import { EvidenceLedger } from "./EvidenceLedger.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { UnknownRegistryError } from "../domain/errors.js";
import type { AnalysisOperation } from "./AnalysisProvider.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import {
  snapshotMatchesBinding,
  snapshotMatchesTarget,
  snapshotTarget,
} from "../domain/analysisSnapshot.js";
import {
  AnalysisSnapshotCache,
  isSnapshotCacheable,
} from "./AnalysisSnapshotCache.js";
import {
  UNKNOWN_REGISTRY_PROVIDER,
  unknownEvidenceLinks,
  unknownMutationEvidence,
} from "./UnknownEvidence.js";
import type { BinarySessionPort } from "./BinarySessionPort.js";
import {
  parseInvestigationWorkspace,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import {
  SessionProviderRouter,
  type SessionProviderRoute,
} from "./SessionProviderRouter.js";
export type { BinarySessionPort } from "./BinarySessionPort.js";
const OFFICIAL_OPERATIONS: ReadonlySet<string> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
);

/**
 * Owns the single active target shared by CLI and MCP adapters.
 *
 * Target transitions are serialized because switching targets tears down the
 * active provider client. A failed switch recreates the previous target instead
 * of retaining a client whose resources were already shut down.
 */
export class BinarySession implements BinarySessionPort {
  #active:
    | {
        readonly target: BinaryTarget;
        readonly client: AnalysisClient;
        readonly profile: AnalysisProfileCommitment | null;
        readonly compatibility: Readonly<Record<string, JsonValue>>;
        readonly route: SessionProviderRoute;
      }
    | undefined;
  #transition: Promise<void> = Promise.resolve();
  readonly #calls = new Set<Promise<unknown>>();
  readonly #providerRouter: SessionProviderRouter;
  readonly #evidence = new EvidenceLedger({
    maxRecords: 10_000,
    maxBytes: 64 * 1024 * 1024,
  });
  readonly #snapshot = new AnalysisSnapshotCache();
  readonly #investigationWorkspaces = new Map<string, InvestigationWorkspace>();
  readonly #runtimeAvailability = new Map<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();
  #snapshotInvalidated = false;

  constructor(
    readonly provider:
      | AnalysisProvider
      | AnalysisClientFactory
      | SessionProviderRouter,
    options: {
      readonly resolveAnalysisProfile?: (
        target: BinaryTarget,
        options?: AnalysisProfileResolutionOptions,
      ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
    } = {},
  ) {
    this.#providerRouter =
      provider instanceof SessionProviderRouter
        ? provider
        : SessionProviderRouter.legacy(provider, options);
  }

  /** Identify the provider producing evidence for this session. */
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity {
    const route = this.#currentRoute();
    let selected = route.identity;
    if (operation !== undefined) {
      const exact = route.capabilities?.get(operation)?.provider;
      if (exact !== undefined) selected = exact;
      else if (enhancedToolNameSchema.safeParse(operation).success) {
        const providers = new Map<string, ProviderIdentity>();
        for (const descriptor of route.capabilities?.values() ?? [])
          if (
            descriptor.available &&
            OFFICIAL_OPERATIONS.has(descriptor.operation)
          )
            providers.set(descriptor.provider.id, descriptor.provider);
        if (providers.size === 1) {
          const provider = providers.values().next().value;
          if (provider !== undefined) selected = provider;
        }
      }
    }
    const profile = this.#active?.profile;
    return structuredClone(
      profile !== null &&
        profile !== undefined &&
        profile.provider.id === selected.id
        ? profile.provider
        : selected,
    );
  }

  /** Return the selected immutable profile, optionally scoped to an operation. */
  analysisProfile(
    operation?: AnalysisOperation,
  ): AnalysisProfileCommitment | undefined {
    const profile = this.#active?.profile;
    if (profile === null || profile === undefined) return undefined;
    if (
      operation !== undefined &&
      this.providerIdentity(operation).id !== profile.provider.id
    )
      return undefined;
    return structuredClone(profile);
  }

  /** Return opaque adapter metadata retained for legacy open_binary output. */
  openCompatibility(): Readonly<Record<string, JsonValue>> {
    return structuredClone(this.#active?.compatibility ?? {});
  }

  /** Observe runtime provider-health changes that affect discovery metadata. */
  onAvailabilityChanged(listener: () => void | Promise<void>): () => void {
    this.#availabilityListeners.add(listener);
    return () => this.#availabilityListeners.delete(listener);
  }

  /** Add one successful public observation to the session ledger. */
  recordEvidence(
    evidence: Evidence,
  ): Result<
    "added" | "duplicate",
    EvidenceIntegrityError | EvidenceLimitError
  > {
    return this.#evidence.record(evidence);
  }

  /** Check that comparison input Evidence is already session-owned. */
  hasEvidence(evidenceId: string): boolean {
    return this.#evidence.has(evidenceId);
  }

  /** Read one detached session-owned Evidence record by semantic ID. */
  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#evidence.get(evidenceId);
  }

  /** Return a deterministic snapshot without clearing session evidence. */
  exportEvidenceBundle(): EvidenceBundle {
    return this.#evidence.export();
  }

  /** Atomically merge a validated evidence bundle into this session. */
  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError> {
    return this.#evidence.import(bundle);
  }

  /** Export immutable cached calls and session evidence for the active target. */
  exportAnalysisSnapshot(): Result<AnalysisSnapshot, AnalysisError> {
    if (this.#snapshotInvalidated)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots are unavailable after analysis metadata mutations",
        ),
      );
    const target = this.#active?.target;
    const profile = this.#active?.profile ?? undefined;
    if (target !== undefined && profile === undefined)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots require a concrete provider analysis profile",
        ),
      );
    return this.#snapshot.export(
      target,
      profile,
      target === undefined
        ? this.#evidence.export()
        : evidenceBundleForTarget(this.#evidence.export(), target.sha256),
    );
  }

  /** Stage validated cached calls for an identical binary and merge its evidence. */
  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError> {
    const active = this.#active;
    if (active?.profile === null)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshot profile_mismatch: the active target has no concrete analysis profile",
        ),
      );
    return this.#snapshot.import(
      snapshot,
      active === undefined
        ? undefined
        : { target: active.target, profile: active.profile },
      (bundle) => this.#evidence.import(bundle),
    );
  }

  /** Retain one validated immutable workspace revision for session resources. */
  retainInvestigationWorkspace(
    workspace: InvestigationWorkspace,
  ): "added" | "duplicate" {
    const parsed = parseInvestigationWorkspace(workspace);
    const key = `${parsed.workspace_id}:${String(parsed.revision)}`;
    if (this.#investigationWorkspaces.has(key)) return "duplicate";
    this.#investigationWorkspaces.set(key, parsed);
    return "added";
  }

  /** Read one session-retained immutable workspace revision. */
  investigationWorkspace(
    workspaceId: string,
    revision: number,
  ): InvestigationWorkspace | undefined {
    const workspace = this.#investigationWorkspaces.get(
      `${workspaceId}:${String(revision)}`,
    );
    return workspace === undefined ? undefined : structuredClone(workspace);
  }

  /** List retained workspace revisions in canonical identity order. */
  investigationWorkspaces(): readonly InvestigationWorkspace[] {
    return [...this.#investigationWorkspaces.values()]
      .sort(
        (left, right) =>
          left.workspace_id.localeCompare(right.workspace_id) ||
          left.revision - right.revision,
      )
      .map((workspace) => structuredClone(workspace));
  }

  /** Create an approved residual unknown and immutable mutation evidence. */
  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const evidence = unknownMutationEvidence(this.#active?.target, input);
    return this.#evidence.recordUnknown(input, evidence);
  }

  /** Atomically record derived Evidence and its approved residual unknown. */
  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#evidence.recordWithUnknown(
      evidence,
      input,
      unknownMutationEvidence(undefined, input),
    );
  }

  /** Update one unknown using compare-and-swap revision semantics. */
  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const evidence = createEvidence(
      this.#active?.target,
      UNKNOWN_REGISTRY_PROVIDER,
      {
        predicateType: "rea.residual-unknown-mutation/v1",
        operation: "update_unknown",
        parameters: {
          unknown_id: input.unknown_id,
          expected_revision: input.expected_revision,
        },
        result: { action: "update", status: input.status },
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: unknownEvidenceLinks(input),
        limitations: [
          "Registry mutation evidence records analyst intent, not proof of the answer.",
        ],
      },
    );
    return this.#evidence.updateUnknown(input, evidence);
  }

  /** Query stable current residual-unknown heads. */
  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#evidence.listUnknowns(filters);
  }

  /** Check whether current head is a bundle-valid resolved state. */
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#evidence.verifyUnknownResolution(unknownId);
  }

  /**
   * Open or switch targets after draining calls against the current target.
   * Returns the switch failure even if best-effort restoration also fails.
   */
  open(
    path: string,
    options: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
      readonly snapshot?: AnalysisSnapshot;
      readonly providerId?: AnalysisProviderSelector;
    } = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    return this.#serialize(async () => {
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      const parsed = await parseBinaryTarget(
        path,
        process.cwd(),
        process.arch,
        options.targetKind,
      );
      if (!parsed.ok) return parsed;
      const sameTarget =
        this.#active?.target.path === parsed.value.path &&
        snapshotMatchesTarget(
          snapshotTarget(this.#active.target),
          parsed.value,
        );
      const resolvedRoute =
        sameTarget &&
        options.providerId === undefined &&
        this.#active !== undefined
          ? ok(this.#active.route)
          : await this.#providerRouter.resolve(
              parsed.value,
              options.providerId,
              options.signal,
            );
      if (!resolvedRoute.ok) return resolvedRoute;
      const route = resolvedRoute.value;
      const { profile, compatibility } = route;
      if (
        options.snapshot !== undefined &&
        (profile === null ||
          !snapshotMatchesBinding(options.snapshot, parsed.value, profile))
      )
        return err(
          new EvidenceIntegrityError(
            "Analysis snapshot profile_mismatch: target, provider, or analysis profile does not match the requested binary",
          ),
        );
      if (
        this.#active === undefined &&
        !this.#snapshot.matches(parsed.value, profile ?? undefined)
      )
        return err(
          new EvidenceIntegrityError(
            "Analysis snapshot profile_mismatch: staged target, provider, or analysis profile does not match",
          ),
        );
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      const activeProfile = this.#active?.profile;
      const sameProfile =
        activeProfile === null || activeProfile === undefined
          ? profile === null
          : profile !== null && analysisProfilesEqual(activeProfile, profile);
      if (sameTarget && sameProfile) {
        if (options.snapshot !== undefined) {
          const imported = this.importAnalysisSnapshot(options.snapshot);
          if (!imported.ok) return imported;
        }
        return ok(parsed.value);
      }
      await this.#drainCalls();
      const previous = this.#active;
      this.#active = undefined;
      await previous?.client.close();
      const client = route.createClient(parsed.value);
      const started = await client.execute("health", {}, options);
      if (!started.ok) {
        await client.close();
        await this.#restore(previous);
        return started;
      }
      if (isAborted(options.signal)) {
        await client.close();
        await this.#restore(previous);
        return err(new AnalysisCancelledError("open_binary"));
      }
      this.#active = {
        target: parsed.value,
        client,
        profile,
        compatibility: structuredClone(compatibility),
        route,
      };
      this.#clearRuntimeAvailability();
      if (profile === null) this.#snapshot.clear();
      else this.#snapshot.select(parsed.value, profile);
      if (options.snapshot !== undefined) {
        const imported = this.importAnalysisSnapshot(options.snapshot);
        if (!imported.ok) {
          this.#active = undefined;
          await client.close();
          await this.#restore(previous);
          return imported;
        }
      }
      this.#snapshotInvalidated = false;
      return ok(parsed.value);
    });
  }

  /** Close the active target, if any. */
  close(): Promise<Result<null, AnalysisError>> {
    return this.#serialize(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await this.#drainCalls();
      await previous?.client.close();
      this.#evidence.clear();
      this.#snapshot.clear();
      this.#snapshotInvalidated = false;
      this.#clearRuntimeAvailability();
      return ok(null);
    });
  }

  /** Describe the active binary session. */
  status(): JsonValue {
    const target = this.#active?.target;
    const route = this.#currentRoute();
    const configuredProvider = this.#providerRouter.configuredIdentity();
    const provider = {
      id: configuredProvider.id,
      name: configuredProvider.name,
      version: configuredProvider.version,
    };
    const providerList = this.#providerRouter
      .providerIdentities(route)
      .map(({ id, name, version }) => ({ id, name, version }));
    const capabilities =
      route.capabilities === undefined
        ? []
        : [...route.capabilities.values()]
            .sort((left, right) =>
              left.operation.localeCompare(right.operation),
            )
            .map((descriptor) => ({
              ...descriptor,
              ...this.#runtimeAvailability.get(descriptor.operation),
            }))
            .map((descriptor) => capabilityStatus(descriptor));
    const analysisProviderBinding =
      route.binding === null
        ? null
        : {
            provider: {
              id: route.binding.identity.id,
              name: route.binding.identity.name,
              version: route.binding.identity.version,
            },
            selection_source: route.binding.selectionSource,
            analysis_profile: structuredClone(route.binding.profile),
          };
    const analysisProviderCandidates = this.#providerRouter
      .candidateStatuses(route)
      .map((candidate) => ({
        provider: {
          id: candidate.provider.id,
          name: candidate.provider.name,
          version: candidate.provider.version,
        },
        availability: {
          status: candidate.availability.status,
          code: candidate.availability.code,
          reason: candidate.availability.reason,
          diagnostics: structuredClone(candidate.availability.diagnostics),
        },
        target_support: {
          status: candidate.targetSupport.status,
          code: candidate.targetSupport.code,
          reason: candidate.targetSupport.reason,
          diagnostics: structuredClone(candidate.targetSupport.diagnostics),
        },
        selected: candidate.selected,
        capabilities: candidate.capabilities
          .slice()
          .sort((left, right) => left.operation.localeCompare(right.operation))
          .map((descriptor) => capabilityStatus(descriptor)),
      }));
    const common = {
      provider,
      providers: providerList,
      capabilities,
      analysis_provider_binding: analysisProviderBinding,
      analysis_provider_candidates: analysisProviderCandidates,
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
  }

  /** Return the immutable artifact identity captured before its provider started. */
  activeTarget(): BinaryTarget | undefined {
    return this.#active === undefined
      ? undefined
      : structuredClone(this.#active.target);
  }

  /**
   * Invoke a provider operation against the active target.
   * Calls may overlap, but a pending target transition prevents new calls from
   * entering until the transition has settled.
   */
  async execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const transitioned = await this.#waitForTransition(name, options?.signal);
    if (!transitioned.ok) return transitioned;
    const active = this.#active;
    if (active === undefined) return err(new NoBinaryOpenError());
    const capability = active.route.capabilities?.get(name);
    if (
      active.route.capabilities !== undefined &&
      capability?.available !== true
    ) {
      const selectionError = this.#providerRouter.unboundOperationError(
        name,
        active.route,
      );
      if (selectionError !== undefined) return err(selectionError);
      return err(
        new AnalysisCapabilityUnavailableError(
          active.route.binding?.identity.id ?? active.route.identity.id,
          name,
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
      isSnapshotCacheable(name, capability, arguments_);
    const cached = cacheable
      ? this.#snapshot.lookup(active.target, profile, name, arguments_)
      : undefined;
    if (cached !== undefined) return ok(cached);
    const call = active.client.execute(name, arguments_, options);
    this.#calls.add(call);
    try {
      const result = await call;
      const profiled = commitExecutionProfile(name, result, profile);
      this.#observeRuntimeAvailability(name, profiled);
      if (profiled.ok && cacheable)
        this.#snapshot.record({
          target: active.target,
          profile,
          operation: name,
          parameters: arguments_,
          execution: profiled.value,
        });
      else if (profiled.ok && capability?.effects.mutatesArtifact === true) {
        this.#snapshot.clear();
        this.#snapshotInvalidated = true;
      }
      return profiled;
    } finally {
      this.#calls.delete(call);
    }
  }

  #observeRuntimeAvailability(
    operation: AnalysisOperation,
    result: Result<AnalysisExecution, AnalysisError>,
  ): void {
    if (result.ok) {
      if (this.#setRuntimeAvailability(operation, true, null))
        this.#emitAvailabilityChanged();
      return;
    }
    if (result.error._tag === "AnalysisCapabilityUnavailableError") {
      if (this.#setRuntimeAvailability(operation, false, result.error.message))
        this.#emitAvailabilityChanged();
      return;
    }
    if (
      [
        "ProviderAdapterError",
        "HopperProcessError",
        "HopperStartError",
        "HopperRemoteError",
      ].includes(result.error._tag)
    ) {
      const capabilities = this.#active?.route.capabilities;
      const providerId = capabilities?.get(operation)?.provider.id;
      let changed = false;
      for (const descriptor of capabilities?.values() ?? [])
        if (providerId !== undefined && descriptor.provider.id === providerId)
          changed =
            this.#setRuntimeAvailability(
              descriptor.operation,
              false,
              "Provider became unavailable during this session.",
            ) || changed;
      if (changed) this.#emitAvailabilityChanged();
    }
  }

  #setRuntimeAvailability(
    operation: string,
    available: boolean,
    reason: string | null,
  ): boolean {
    const current = this.#runtimeAvailability.get(operation);
    if (current?.available === available && current.reason === reason)
      return false;
    if (available && current === undefined) return false;
    if (available) this.#runtimeAvailability.delete(operation);
    else this.#runtimeAvailability.set(operation, { available, reason });
    return true;
  }

  #clearRuntimeAvailability(): void {
    if (this.#runtimeAvailability.size === 0) return;
    this.#runtimeAvailability.clear();
    this.#emitAvailabilityChanged();
  }

  #emitAvailabilityChanged(): void {
    for (const listener of this.#availabilityListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch {
        // External observers are best-effort notifications. Contain only the
        // callback failure so state transitions and other listeners continue.
      }
    }
  }

  #currentRoute(): SessionProviderRoute {
    return this.#active?.route ?? this.#providerRouter.initialRoute();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(operation, operation);
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #drainCalls(): Promise<void> {
    await Promise.allSettled(this.#calls);
  }

  async #restore(
    previous:
      | {
          readonly target: BinaryTarget;
          readonly client: AnalysisClient;
          readonly profile: AnalysisProfileCommitment | null;
          readonly compatibility: Readonly<Record<string, JsonValue>>;
          readonly route: SessionProviderRoute;
        }
      | undefined,
  ): Promise<void> {
    if (previous === undefined) return;
    const client = previous.route.createClient(previous.target);
    const started = await client.execute("health", {});
    if (started.ok)
      this.#active = {
        target: previous.target,
        client,
        profile: previous.profile,
        compatibility: previous.compatibility,
        route: previous.route,
      };
    else await client.close();
  }

  async #waitForTransition(
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<undefined, AnalysisCancelledError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    if (signal === undefined) {
      await this.#transition;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(err(new AnalysisCancelledError(operation)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#transition.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted
              ? err(new AnalysisCancelledError(operation))
              : ok(undefined),
          );
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted
              ? err(new AnalysisCancelledError(operation))
              : ok(undefined),
          );
        },
      );
    });
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const commitExecutionProfile = (
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

const capabilityStatus = (
  descriptor: Omit<CapabilityDescriptor, "available" | "reason"> & {
    readonly available: boolean;
    readonly reason: string | null;
  },
) => ({
  operation: descriptor.operation,
  available: descriptor.available,
  reason: descriptor.reason,
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
