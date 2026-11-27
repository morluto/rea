import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { AnalysisCleanupRelease } from "../../domain/analysisCleanupRelease.js";
import {
  closedAnalysisClientError,
  ProviderAdapterError,
} from "../../domain/providerAdapterError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { err, ok } from "../../domain/result.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProviderBoundClientFactory,
  AnalysisProvider,
  CapabilityDescriptor,
  ExecutionOptions,
  ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import { closeAnalysisClient } from "../../providers/AnalysisClientCleanup.js";
import {
  engineCloseReportOf,
  retainCloseOutcome,
} from "../../domain/engineCloseReport.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";

/** Synthetic identity for a deterministic provider set. */
const compositeProviderIdentity = (
  identities: readonly ProviderIdentity[],
): ProviderIdentity => ({
  id: `composite:${identities
    .map(({ id }) => id)
    .sort()
    .join("+")}`,
  name: "REA composite analysis provider",
  version: null,
});

/** A retained error needs only the release records, not the clients being closed. */
const allClientsReleased = (releases: readonly AnalysisCleanupRelease[]) => ({
  get cleanupReleased(): boolean {
    return releases.every((release) => release.cleanupReleased);
  },
});

const closeCompositeClients = (
  identity: ProviderIdentity,
  clients: ReadonlyMap<AnalysisProvider, AnalysisClient>,
): AnalysisClient["close"] => {
  const releases = new WeakMap<AnalysisClient, AnalysisCleanupRelease>();
  return async (options) => {
    const outcomes = await Promise.all(
      [...clients.entries()].map(async ([provider, client]) => {
        const providerId = provider.identity().id;
        let release = releases.get(client);
        if (release === undefined) {
          release = new AnalysisCleanupRelease();
          releases.set(client, release);
        }
        if (release.cleanupReleased)
          return { providerId, release, result: ok(null) };
        const result = await closeAnalysisClient(
          client,
          providerId,
          options,
          release,
        );
        if (result.ok) release.confirm();
        return { providerId, release, result };
      }),
    );
    const failures = outcomes.flatMap(({ providerId, release, result }) =>
      result.ok ? [] : [{ providerId, release, error: result.error }],
    );
    // A child that released its engine reports it now, even when a sibling
    // fails: a retry skips that released child and could not report it.
    const report = engineCloseReportOf(...outcomes.map(({ result }) => result));
    if (failures.length === 0) return ok(report);
    if (failures.length === 1) {
      const failure = failures[0];
      if (failure !== undefined)
        return err(retainCloseOutcome(failure.error, report));
    }
    const unknownReleases = failures.flatMap(({ error, release }) =>
      error.carriesCleanup ? [] : [release],
    );
    const aggregate = new ProviderCleanupError(
      identity.id,
      [],
      {
        reason:
          "Multiple composed provider clients could not be confirmed closed.",
        failures: failures.map(({ providerId, error }) => ({
          provider_id: providerId,
          message: error.message,
          resources: [...error.cleanupResources],
          ...(error.diagnostics === undefined
            ? {}
            : { diagnostics: error.diagnostics }),
        })),
      },
      {
        remediationAction: [
          ...new Set(
            failures.map(
              ({ error }) => projectAnalysisError(error).remediation.action,
            ),
          ),
        ].join("\n"),
        cause: new AggregateError(
          failures.map(({ error }) => error),
          "Composed provider cleanup failed.",
        ),
      },
    )
      .bindCleanupDependencies(failures.map(({ error }) => error))
      .bindCleanupReleaseClaim(allClientsReleased(unknownReleases));
    return err(retainCloseOutcome(aggregate, report));
  };
};

const executeCompositeHealth = async (
  identity: ProviderIdentity,
  clients: ReadonlyMap<AnalysisProvider, AnalysisClient>,
  options: ExecutionOptions | undefined,
): ReturnType<AnalysisClient["execute"]> => {
  for (const [provider, client] of clients) {
    const health = client.operationHealthSnapshot?.();
    if (
      health !== undefined &&
      health.state !== "idle" &&
      health.state !== "busy"
    )
      return err(
        new ProviderAdapterError(provider.identity().id, "health", {
          diagnostics: {
            reason: `instantiated provider client is ${health.state}`,
          },
        }),
      );
    const checked = await client.execute("health", {}, options);
    if (!checked.ok) return checked;
  }
  return ok({
    result: null,
    rawResult: null,
    provider: identity,
    limitations: [],
    locations: [],
    subject: null,
  });
};

/** Deterministically route disjoint operations without eagerly starting children. */
export class CompositeProvider implements AnalysisProvider {
  readonly #identity: ProviderIdentity;
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #providerByOperation: ReadonlyMap<string, AnalysisProvider>;
  readonly #boundClientFactories: ReadonlyMap<
    string,
    AnalysisProviderBoundClientFactory
  >;

  constructor(
    readonly providers: readonly AnalysisProvider[],
    boundClientFactories: ReadonlyMap<
      string,
      AnalysisProviderBoundClientFactory
    > = new Map(),
  ) {
    this.#boundClientFactories = boundClientFactories;
    if (providers.length === 0)
      throw new RangeError("CompositeProvider requires at least one provider");
    this.#identity = Object.freeze(
      compositeProviderIdentity(
        providers.map((provider) => provider.identity()),
      ),
    );
    const routes = new Map<string, AnalysisProvider>();
    const capabilities: CapabilityDescriptor[] = [];
    for (const provider of providers) {
      for (const descriptor of provider.capabilities()) {
        if (routes.has(descriptor.operation))
          throw new TypeError(
            `Multiple providers declare operation ${descriptor.operation}`,
          );
        routes.set(descriptor.operation, provider);
        capabilities.push(descriptor);
      }
    }
    this.#providerByOperation = routes;
    this.#capabilities = Object.freeze(
      capabilities.sort(
        (left, right) =>
          compareUnicodeCodePoints(left.operation, right.operation) ||
          compareUnicodeCodePoints(left.provider.id, right.provider.id),
      ),
    );
  }

  identity(): ProviderIdentity {
    return this.#identity;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    const clients = new Map<AnalysisProvider, AnalysisClient>();
    const clientFor = (provider: AnalysisProvider): AnalysisClient => {
      const existing = clients.get(provider);
      if (existing !== undefined) return existing;
      const providerProfile =
        profile?.provider.id === provider.identity().id ? profile : undefined;
      const factory = this.#boundClientFactories.get(provider.identity().id);
      const created =
        factory !== undefined && providerProfile !== undefined
          ? factory(target, providerProfile, context)
          : provider.createClient(target, providerProfile, context);
      clients.set(provider, created);
      return created;
    };
    let closed = false;
    const closeClients = closeCompositeClients(this.#identity, clients);
    const close: AnalysisClient["close"] = (options) => {
      closed = true;
      return closeClients(options);
    };
    return {
      executeIfReady: (operation, parameters, options) => {
        const provider = this.#providerByOperation.get(operation);
        const client =
          provider === undefined || closed ? undefined : clients.get(provider);
        return (
          client?.executeIfReady?.(operation, parameters, options) ??
          Promise.resolve(undefined)
        );
      },
      execute: async (operation, parameters, options) => {
        if (closed)
          return err(closedAnalysisClientError(this.#identity.id, operation));
        if (operation === "health")
          return executeCompositeHealth(this.#identity, clients, options);
        const provider = this.#providerByOperation.get(operation);
        return provider === undefined
          ? Promise.resolve(
              err(
                new AnalysisCapabilityUnavailableError(
                  this.#identity.id,
                  operation,
                  "operation is not declared by this provider set",
                ),
              ),
            )
          : clientFor(provider).execute(operation, parameters, options);
      },
      runtimeLineageSnapshots: () =>
        [...clients.values()]
          .flatMap((client) => client.runtimeLineageSnapshots?.() ?? [])
          .sort((left, right) =>
            compareUnicodeCodePoints(left.provider.id, right.provider.id),
          ),
      requestActivitySnapshots: () =>
        [...clients.values()]
          .flatMap((client) => client.requestActivitySnapshots?.() ?? [])
          .sort((left, right) =>
            compareUnicodeCodePoints(left.provider.id, right.provider.id),
          ),
      reuseReadiness: () => {
        if (closed) return "blocked";
        const states = [...clients.values()].map(
          (client) => client.reuseReadiness?.() ?? "unknown",
        );
        if (states.some((state) => state === "blocked")) return "blocked";
        return states.some((state) => state === "unknown")
          ? "unknown"
          : "ready";
      },
      unsavedCloseReport: () =>
        [...clients.values()]
          .map((client) => client.unsavedCloseReport?.() ?? null)
          .find((report) => report !== null) ?? null,
      operationHealthSnapshot: () => {
        const snapshots = [...clients.values()].map((client) =>
          client.operationHealthSnapshot?.(),
        );
        const failed = snapshots.find(
          (snapshot) =>
            snapshot !== undefined &&
            (snapshot.state === "exited" ||
              snapshot.state === "unreachable" ||
              snapshot.state === "not_started"),
        );
        if (failed !== undefined) return failed;
        const nonIdle = snapshots.find(
          (snapshot) => snapshot !== undefined && snapshot.state !== "idle",
        );
        if (nonIdle !== undefined) return nonIdle;
        if (snapshots.some((snapshot) => snapshot === undefined))
          return undefined;
        return snapshots[0];
      },
      close,
    };
  }
}
