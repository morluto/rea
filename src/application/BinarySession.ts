import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
  EvidenceLimitError,
  AnalysisCancelledError,
  NoBinaryOpenError,
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
export type { BinarySessionPort } from "./BinarySessionPort.js";
const OFFICIAL_OPERATIONS: ReadonlySet<string> = new Set(
  OFFICIAL_TOOL_CONTRACTS.map(({ name }) => name),
);

/**
 * Owns the single active target shared by CLI and MCP adapters.
 *
 * Target transitions are serialized because each client dispatches Hopper API
 * work on its dedicated Python thread, and switching targets tears that bridge
 * down. A failed switch recreates the previous target instead of retaining a
 * client whose bridge was already shut down.
 */
export class BinarySession implements BinarySessionPort {
  #active:
    | { readonly target: BinaryTarget; readonly client: AnalysisClient }
    | undefined;
  #transition: Promise<void> = Promise.resolve();
  readonly #calls = new Set<Promise<unknown>>();
  readonly #createClient: AnalysisClientFactory;
  readonly #providerIdentity: ProviderIdentity;
  readonly #capabilities: ReadonlyMap<string, CapabilityDescriptor> | undefined;
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
  readonly #snapshotsEnabled: boolean;
  #snapshotInvalidated = false;

  constructor(
    readonly provider: AnalysisProvider | AnalysisClientFactory,
    options: { readonly snapshotsEnabled?: boolean } = {},
  ) {
    this.#snapshotsEnabled = options.snapshotsEnabled ?? true;
    this.#createClient =
      typeof provider === "function"
        ? provider
        : (target) => provider.createClient(target);
    this.#providerIdentity =
      typeof provider === "function"
        ? { id: "unidentified", name: "Unidentified provider", version: null }
        : provider.identity();
    this.#capabilities =
      typeof provider === "function"
        ? undefined
        : new Map(
            provider
              .capabilities()
              .map((descriptor) => [descriptor.operation, descriptor]),
          );
  }

  /** Identify the provider producing evidence for this session. */
  providerIdentity(operation?: AnalysisOperation): ProviderIdentity {
    if (operation !== undefined) {
      const exact = this.#capabilities?.get(operation)?.provider;
      if (exact !== undefined) return structuredClone(exact);
      if (enhancedToolNameSchema.safeParse(operation).success) {
        const providers = new Map<string, ProviderIdentity>();
        for (const descriptor of this.#capabilities?.values() ?? [])
          if (
            descriptor.available &&
            OFFICIAL_OPERATIONS.has(descriptor.operation)
          )
            providers.set(descriptor.provider.id, descriptor.provider);
        if (providers.size === 1) {
          const provider = providers.values().next().value;
          if (provider !== undefined) return structuredClone(provider);
        }
      }
    }
    return structuredClone(this.#providerIdentity);
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
    if (!this.#snapshotsEnabled)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots are unavailable with custom Hopper loader arguments",
        ),
      );
    if (this.#snapshotInvalidated)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots are unavailable after analysis metadata mutations",
        ),
      );
    const target = this.#active?.target;
    return this.#snapshot.export(
      target,
      target === undefined
        ? this.#evidence.export()
        : evidenceBundleForTarget(this.#evidence.export(), target.sha256),
    );
  }

  /** Stage validated cached calls for an identical binary and merge its evidence. */
  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError> {
    if (!this.#snapshotsEnabled)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots are unavailable with custom Hopper loader arguments",
        ),
      );
    return this.#snapshot.import(snapshot, this.#active?.target, (bundle) =>
      this.#evidence.import(bundle),
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
      if (
        options.snapshot !== undefined &&
        !snapshotMatchesTarget(options.snapshot.target, parsed.value)
      )
        return err(
          new EvidenceIntegrityError(
            "Analysis snapshot target does not match the requested binary",
          ),
        );
      if (this.#active === undefined && !this.#snapshot.matches(parsed.value))
        return err(
          new EvidenceIntegrityError(
            "Analysis snapshot target does not match the requested binary",
          ),
        );
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      if (
        this.#active?.target.path === parsed.value.path &&
        snapshotMatchesTarget(snapshotTarget(this.#active.target), parsed.value)
      ) {
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
      const client = this.#createClient(parsed.value);
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
      this.#active = { target: parsed.value, client };
      this.#clearRuntimeAvailability();
      this.#snapshot.select(parsed.value);
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
    const provider = {
      id: this.#providerIdentity.id,
      name: this.#providerIdentity.name,
      version: this.#providerIdentity.version,
    };
    const providers = new Map<string, ProviderIdentity>();
    if (this.#capabilities === undefined) providers.set(provider.id, provider);
    else
      for (const descriptor of this.#capabilities.values())
        providers.set(descriptor.provider.id, descriptor.provider);
    const providerList = [...providers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name, version }) => ({ id, name, version }));
    const capabilities =
      this.#capabilities === undefined
        ? []
        : [...this.#capabilities.values()]
            .sort((left, right) =>
              left.operation.localeCompare(right.operation),
            )
            .map((descriptor) => ({
              ...descriptor,
              ...this.#runtimeAvailability.get(descriptor.operation),
            }))
            .map((descriptor) => ({
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
            }));
    return target === undefined
      ? { open: false, provider, providers: providerList, capabilities }
      : {
          open: true,
          provider,
          providers: providerList,
          capabilities,
          path: target.path,
          sha256: target.sha256,
          format: target.format,
          kind: target.kind,
          architecture: target.architecture ?? null,
        };
  }

  /** Return the immutable artifact identity captured before Hopper launched. */
  activeTarget(): BinaryTarget | undefined {
    return this.#active === undefined
      ? undefined
      : structuredClone(this.#active.target);
  }

  /**
   * Invoke a Hopper tool against the active target.
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
    const capability = this.#capabilities?.get(name);
    if (this.#capabilities !== undefined && capability?.available !== true)
      return err(
        new AnalysisCapabilityUnavailableError(
          this.#providerIdentity.id,
          name,
          capability?.reason ?? "operation is not declared by this provider",
        ),
      );
    const active = this.#active;
    if (active === undefined) return err(new NoBinaryOpenError());
    const cacheable = isSnapshotCacheable(name, capability, arguments_);
    const cached = cacheable
      ? this.#snapshot.lookup(
          active.target,
          name,
          arguments_,
          capability.provider,
        )
      : undefined;
    if (cached !== undefined) return ok(cached);
    const call = active.client.execute(name, arguments_, options);
    this.#calls.add(call);
    try {
      const result = await call;
      this.#observeRuntimeAvailability(name, result);
      if (result.ok && cacheable)
        this.#snapshot.record(active.target, name, arguments_, result.value);
      else if (result.ok && capability?.effects.mutatesArtifact === true) {
        this.#snapshot.clear();
        this.#snapshotInvalidated = true;
      }
      return result;
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
      const providerId = this.#capabilities?.get(operation)?.provider.id;
      let changed = false;
      for (const descriptor of this.#capabilities?.values() ?? [])
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
      | { readonly target: BinaryTarget; readonly client: AnalysisClient }
      | undefined,
  ): Promise<void> {
    if (previous === undefined) return;
    const client = this.#createClient(previous.target);
    const started = await client.execute("health", {});
    if (started.ok) this.#active = { target: previous.target, client };
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
