import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import { closeAnalysisClient } from "./AnalysisClientCleanup.js";
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

/** Deterministically route disjoint operations without eagerly starting children. */
export class CompositeProvider implements AnalysisProvider {
  readonly #identity: ProviderIdentity;
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #providerByOperation: ReadonlyMap<string, AnalysisProvider>;

  constructor(readonly providers: readonly AnalysisProvider[]) {
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
      const created = provider.createClient(
        target,
        profile?.provider.id === provider.identity().id ? profile : undefined,
        context,
      );
      clients.set(provider, created);
      return created;
    };
    const close: AnalysisClient["close"] = async (options) => {
      const outcomes = await Promise.all(
        [...clients.entries()].map(([provider, client]) =>
          closeAnalysisClient(client, provider.identity().id, options),
        ),
      );
      return outcomes.find((outcome) => !outcome.ok) ?? ok(null);
    };
    return {
      executeIfReady: (operation, parameters, options) => {
        const provider = this.#providerByOperation.get(operation);
        const client =
          provider === undefined ? undefined : clients.get(provider);
        return (
          client?.executeIfReady?.(operation, parameters, options) ??
          Promise.resolve(undefined)
        );
      },
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
            compareUnicodeCodePoints(left.provider.id, right.provider.id),
          ),
      requestActivitySnapshots: () =>
        [...clients.values()]
          .flatMap((client) => client.requestActivitySnapshots?.() ?? [])
          .sort((left, right) =>
            compareUnicodeCodePoints(left.provider.id, right.provider.id),
          ),
      operationHealthSnapshot: () => {
        for (const client of clients.values()) {
          const snapshot = client.operationHealthSnapshot?.();
          if (snapshot !== undefined && snapshot.state !== "idle")
            return snapshot;
        }
        for (const client of clients.values()) {
          const snapshot = client.operationHealthSnapshot?.();
          if (snapshot !== undefined) return snapshot;
        }
        return undefined;
      },
      close,
    };
  }
}
