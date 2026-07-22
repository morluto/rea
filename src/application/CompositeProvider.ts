import { AnalysisCapabilityUnavailableError } from "../domain/errors.js";
import { err, ok } from "../domain/result.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProfileResolutionOptions,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "./AnalysisProvider.js";

/** Synthetic compatibility identity for a deterministic provider set. */
export const compositeProviderIdentity = (
  identities: readonly ProviderIdentity[],
): ProviderIdentity => ({
  id: `composite:${identities
    .map(({ id }) => id)
    .sort()
    .join("+")}`,
  name: "REA composite analysis provider",
  version: null,
});

/** Deterministically route disjoint operations without eagerly starting children. */
export class CompositeProvider implements AnalysisProvider {
  readonly #identity: ProviderIdentity;
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #providerByOperation: ReadonlyMap<string, AnalysisProvider>;
  readonly #profileProvider: AnalysisProvider | undefined;

  constructor(readonly providers: readonly AnalysisProvider[]) {
    if (providers.length === 0)
      throw new RangeError("CompositeProvider requires at least one provider");
    const profileProviders = providers.filter(
      ({ resolveAnalysisProfile }) => resolveAnalysisProfile !== undefined,
    );
    if (profileProviders.length > 1)
      throw new TypeError(
        "CompositeProvider supports at most one target-bound analysis profile",
      );
    this.#profileProvider = profileProviders[0];
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
          left.operation.localeCompare(right.operation) ||
          left.provider.id.localeCompare(right.provider.id),
      ),
    );
  }

  identity(): ProviderIdentity {
    return this.#identity;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    const resolve = this.#profileProvider?.resolveAnalysisProfile;
    return resolve === undefined
      ? Promise.resolve(ok({ profile: null, compatibility: {} }))
      : resolve.call(this.#profileProvider, target, options);
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
      const created = provider.createClient(
        target,
        profile?.provider.id === provider.identity().id ? profile : undefined,
        context,
      );
      clients.set(provider, created);
      return created;
    };
    return {
      execute: (operation, parameters, options) => {
        if (operation === "health")
          return Promise.resolve(
            ok({
              result: null,
              rawResult: null,
              provider: this.#identity,
              limitations: [],
              locations: [],
              subject: null,
            }),
          );
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
            left.provider.id.localeCompare(right.provider.id),
          ),
      close: async () => {
        await Promise.allSettled(
          [...clients.values()].map(async (client) => client.close()),
        );
      },
    };
  }
}
