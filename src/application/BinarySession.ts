import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  analysisProfilesEqual,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import {
  AnalysisCancelledError,
  ProviderAdapterError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisClientFactory,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisOperationPort,
  AnalysisProvider,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import type { AnalysisOperation } from "./AnalysisProvider.js";
import { enhancedToolNameSchema } from "../contracts/enhancedInputs.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { BinarySessionPort } from "./BinarySessionPort.js";
import {
  SessionProviderRouter,
  type SessionProviderRoute,
} from "./SessionProviderRouter.js";
import { BinarySessionRecords } from "./BinarySessionRecords.js";
import { binarySessionStatus } from "./BinarySessionStatus.js";
import {
  resolveSessionOpen,
  type BinarySessionOpenOptions,
} from "./BinarySessionOpen.js";
import { prepareSessionExecution } from "./BinarySessionExecution.js";
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
export class BinarySession
  extends BinarySessionRecords
  implements BinarySessionPort
{
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
  readonly #runtimeAvailability = new Map<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();

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
    super();
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

  /**
   * Open or switch targets after draining calls against the current target.
   * Returns the switch failure even if best-effort restoration also fails.
   */
  open(
    path: string,
    options: BinarySessionOpenOptions = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    return this.#serialize(async () => {
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      const resolved = await resolveSessionOpen({
        router: this.#providerRouter,
        current: this.#active,
        path,
        options,
        stagedSnapshotMatches: (target, profile) =>
          this.matchesSnapshot(target, profile),
      });
      if (!resolved.ok) return resolved;
      const { target, route, sameTarget } = resolved.value;
      const { profile, compatibility } = route;
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
        return ok(target);
      }
      await this.#drainCalls();
      const previous = this.#active;
      this.#active = undefined;
      await previous?.client.close();
      const client = route.createClient(target);
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
        target,
        client,
        profile,
        compatibility: structuredClone(compatibility),
        route,
      };
      this.#clearRuntimeAvailability();
      if (profile === null) this.clearSnapshot();
      else this.selectSnapshot(target, profile);
      if (options.snapshot !== undefined) {
        const imported = this.importAnalysisSnapshot(options.snapshot);
        if (!imported.ok) {
          this.#active = undefined;
          await client.close();
          await this.#restore(previous);
          return imported;
        }
      }
      this.resetSnapshotInvalidation();
      return ok(target);
    });
  }

  /** Close the active target, if any. */
  close(): Promise<Result<null, AnalysisError>> {
    return this.#serialize(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await this.#drainCalls();
      await previous?.client.close();
      this.clearSessionRecords();
      this.#clearRuntimeAvailability();
      return ok(null);
    });
  }

  /** Describe the active binary session. */
  status(): JsonValue {
    return binarySessionStatus({
      target: this.#active?.target,
      route: this.#currentRoute(),
      router: this.#providerRouter,
      runtimeAvailability: this.#runtimeAvailability,
    });
  }

  /** Return the immutable artifact identity captured before its provider started. */
  activeTarget(): BinaryTarget | undefined {
    return this.#active === undefined
      ? undefined
      : structuredClone(this.#active.target);
  }

  protected activeAnalysisBinding() {
    return this.#active;
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
    const prepared = prepareSessionExecution({
      active: this.#active,
      operation: name,
      parameters: arguments_,
      unboundOperationError: (operation, route) =>
        this.#providerRouter.unboundOperationError(operation, route),
      lookupSnapshot: (target, profile, operation, parameters) =>
        this.lookupSnapshot(target, profile, operation, parameters),
    });
    if (!prepared.ok) return prepared;
    const { active, capability, profile, cacheable, cached } = prepared.value;
    if (cached !== undefined) return ok(cached);
    const call = active.client.execute(name, arguments_, options);
    this.#calls.add(call);
    try {
      const result = await call;
      const profiled = commitExecutionProfile(name, result, profile);
      this.#observeRuntimeAvailability(name, profiled);
      if (profiled.ok && cacheable && profile !== undefined)
        this.recordSnapshot({
          target: active.target,
          profile,
          operation: name,
          parameters: arguments_,
          execution: profiled.value,
        });
      else if (profiled.ok && capability?.effects.mutatesArtifact === true) {
        this.invalidateSnapshot();
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
