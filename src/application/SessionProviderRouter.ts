import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import {
  analysisProfileSchema,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  ProviderAdapterError,
  ProviderSelectionError,
  type AnalysisError,
} from "../domain/errors.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisClientFactory,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "./AnalysisProvider.js";
import {
  AnalysisProviderRegistry,
  type AnalysisProviderBinding,
  type AnalysisProviderCandidateStatus,
  type AnalysisProviderSelection,
} from "./AnalysisProviderRegistry.js";
import { ABORTED, waitForAbortable } from "./AbortablePromise.js";
import {
  CompositeProvider,
  compositeProviderIdentity,
} from "./CompositeProvider.js";

/** Immutable operation routes and binding metadata for one target transition. */
export interface SessionProviderRoute {
  readonly identity: ProviderIdentity;
  readonly capabilities: ReadonlyMap<string, CapabilityDescriptor> | undefined;
  readonly profile: AnalysisProfileCommitment | null;
  readonly compatibility: Readonly<Record<string, JsonValue>>;
  readonly binding: AnalysisProviderBinding | null;
  readonly selection: AnalysisProviderSelection | undefined;
  createClient(
    target: BinaryTarget,
    context: AnalysisClientContext,
  ): AnalysisClient;
}

interface LegacyProviderRuntime {
  readonly kind: "legacy";
  readonly provider: AnalysisProvider | AnalysisClientFactory;
  readonly identity: ProviderIdentity;
  readonly capabilities: ReadonlyMap<string, CapabilityDescriptor> | undefined;
  readonly resolveProfile: (
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
}

interface SelectableProviderRuntime {
  readonly kind: "selectable";
  readonly registry: AnalysisProviderRegistry;
  readonly auxiliaryProviders: readonly AnalysisProvider[];
  readonly identity: ProviderIdentity;
  readonly initialRoute: SessionProviderRoute;
}

/** Resolve either the compatibility single-provider seam or a selectable set. */
export class SessionProviderRouter {
  private constructor(
    private readonly runtime: LegacyProviderRuntime | SelectableProviderRuntime,
  ) {}

  /** Preserve the existing provider/factory seam used by focused embedders. */
  static legacy(
    provider: AnalysisProvider | AnalysisClientFactory,
    options: {
      readonly resolveAnalysisProfile?: (
        target: BinaryTarget,
        resolutionOptions?: AnalysisProfileResolutionOptions,
      ) => Promise<Result<AnalysisProfileResolution, AnalysisError>>;
    } = {},
  ): SessionProviderRouter {
    const identity =
      typeof provider === "function"
        ? { id: "unidentified", name: "Unidentified provider", version: null }
        : provider.identity();
    const capabilities =
      typeof provider === "function"
        ? undefined
        : capabilityMap(provider.capabilities());
    const resolveProfile =
      options.resolveAnalysisProfile ??
      (typeof provider === "function" ||
      provider.resolveAnalysisProfile === undefined
        ? () => Promise.resolve(ok({ profile: null, compatibility: {} }))
        : (
            target: BinaryTarget,
            resolutionOptions?: AnalysisProfileResolutionOptions,
          ) =>
            provider.resolveAnalysisProfile?.(target, resolutionOptions) ??
            Promise.resolve(ok({ profile: null, compatibility: {} })));
    return new SessionProviderRouter({
      kind: "legacy",
      provider,
      identity,
      capabilities,
      resolveProfile,
    });
  }

  /** Create selection-aware routing while keeping auxiliary families disjoint. */
  static selectable(
    registry: AnalysisProviderRegistry,
    auxiliaryProviders: readonly AnalysisProvider[],
  ): SessionProviderRouter {
    const identities = [
      ...registry.identities(),
      ...auxiliaryProviders.map((provider) => provider.identity()),
    ];
    assertUniqueProviderIds(identities);
    const auxiliaryOperations = assertDisjoint(auxiliaryProviders);
    for (const operation of registry.declaredOperations())
      if (auxiliaryOperations.has(operation))
        throw new TypeError(
          `Deep and auxiliary providers both declare operation ${operation}`,
        );
    const initialRoute = selectableRoute(auxiliaryProviders, undefined);
    return new SessionProviderRouter({
      kind: "selectable",
      registry,
      auxiliaryProviders: [...auxiliaryProviders],
      identity:
        identities.length === 0
          ? emptyProviderIdentity()
          : compositeProviderIdentity(identities),
      initialRoute,
    });
  }

  /** Compatibility identity covering every configured provider. */
  configuredIdentity(): ProviderIdentity {
    return structuredClone(this.runtime.identity);
  }

  /** Provider identities exposed through the flat 1.x compatibility field. */
  providerIdentities(route: SessionProviderRoute): readonly ProviderIdentity[] {
    if (this.runtime.kind === "legacy") {
      if (route.capabilities === undefined) return [route.identity];
      return uniqueProviderIdentities(
        [...route.capabilities.values()].map(({ provider }) => provider),
      );
    }
    const selected = route.binding?.identity;
    return uniqueProviderIdentities([
      ...this.runtime.auxiliaryProviders.map((provider) => provider.identity()),
      ...this.runtime.registry
        .identities()
        .map((identity) =>
          identity.id === selected?.id ? selected : identity,
        ),
    ]);
  }

  /** Target-free routes and discovery metadata. */
  initialRoute(): SessionProviderRoute {
    if (this.runtime.kind === "selectable") return this.runtime.initialRoute;
    const runtime = this.runtime;
    return {
      identity: structuredClone(runtime.identity),
      capabilities: runtime.capabilities,
      profile: null,
      compatibility: {},
      binding: null,
      selection: undefined,
      createClient: (target, context) =>
        createLegacyClient(runtime, target, undefined, context),
    };
  }

  /** Resolve target routes before any provider client is created. */
  async resolve(
    target: BinaryTarget,
    providerId?: AnalysisProviderSelector,
    signal?: AbortSignal,
  ): Promise<Result<SessionProviderRoute, AnalysisError>> {
    const resolutionOptions = signal === undefined ? undefined : { signal };
    if (this.runtime.kind === "selectable") {
      const selected = await this.runtime.registry.select(
        target,
        providerId,
        resolutionOptions,
      );
      return selected.ok
        ? ok(selectableRoute(this.runtime.auxiliaryProviders, selected.value))
        : selected;
    }
    const runtime = this.runtime;
    if (
      providerId !== undefined &&
      providerId !== "auto" &&
      providerId !== runtime.identity.id
    )
      return err(
        new ProviderSelectionError({
          reason: "unknown_provider",
          requestedProviderId: providerId,
          candidateIds: [runtime.identity.id],
        }),
      );
    const resolved = await waitForAbortable(
      runtime.resolveProfile(target, resolutionOptions),
      signal,
    );
    if (resolved === ABORTED)
      return err(new AnalysisCancelledError("open_binary"));
    if (!resolved.ok) return resolved;
    const normalized = normalizeProfileResolution(
      resolved.value,
      runtime.identity.id,
    );
    if (!normalized.ok) return normalized;
    return ok({
      identity: structuredClone(runtime.identity),
      capabilities: runtime.capabilities,
      profile: normalized.value.profile,
      compatibility: normalized.value.compatibility,
      binding: null,
      selection: undefined,
      createClient: (openedTarget, context) =>
        createLegacyClient(
          runtime,
          openedTarget,
          normalized.value.profile ?? undefined,
          context,
        ),
    });
  }

  /** Candidate status authoritative for the active or target-free route. */
  candidateStatuses(
    route: SessionProviderRoute,
  ): readonly AnalysisProviderCandidateStatus[] {
    if (this.runtime.kind === "legacy") return [];
    return route.selection?.candidates ?? this.runtime.registry.candidates();
  }

  /** Produce exact candidate rejections for an intentionally unbound route. */
  unboundOperationError(
    operation: string,
    route: SessionProviderRoute,
  ): ProviderSelectionError | undefined {
    if (
      this.runtime.kind !== "selectable" ||
      route.binding !== null ||
      route.selection === undefined
    )
      return undefined;
    return this.runtime.registry.unboundOperationError(
      operation,
      route.selection,
    );
  }
}

const selectableRoute = (
  auxiliaryProviders: readonly AnalysisProvider[],
  selection: AnalysisProviderSelection | undefined,
): SessionProviderRoute => {
  const binding = selection?.binding ?? null;
  const providers = [
    ...auxiliaryProviders,
    ...(binding === null ? [] : [binding.provider]),
  ];
  const provider =
    providers.length === 0 ? undefined : new CompositeProvider(providers);
  const identity = provider?.identity() ?? emptyProviderIdentity();
  const capabilities = capabilityMap(provider?.capabilities() ?? []);
  return {
    identity,
    capabilities,
    profile: binding?.profile ?? null,
    compatibility: structuredClone(binding?.compatibility ?? {}),
    binding,
    selection,
    createClient: (target, context) =>
      provider?.createClient(target, binding?.profile, context) ??
      emptyClient(identity),
  };
};

const createLegacyClient = (
  runtime: LegacyProviderRuntime,
  target: BinaryTarget,
  profile: AnalysisProfileCommitment | undefined,
  context: AnalysisClientContext,
): AnalysisClient =>
  typeof runtime.provider === "function"
    ? runtime.provider(target, profile, context)
    : runtime.provider.createClient(target, profile, context);

const emptyClient = (identity: ProviderIdentity): AnalysisClient => ({
  execute: (operation) =>
    operation === "health"
      ? Promise.resolve(
          ok({
            result: null,
            rawResult: null,
            provider: identity,
            limitations: [],
            locations: [],
            subject: null,
          }),
        )
      : Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              identity.id,
              operation,
              "operation is not declared by this provider set",
            ),
          ),
        ),
  close: () => Promise.resolve(),
});

const emptyProviderIdentity = (): ProviderIdentity => ({
  id: "composite:none",
  name: "REA composite analysis provider",
  version: null,
});

const capabilityMap = (
  capabilities: readonly CapabilityDescriptor[],
): ReadonlyMap<string, CapabilityDescriptor> =>
  new Map(capabilities.map((descriptor) => [descriptor.operation, descriptor]));

const uniqueProviderIdentities = (
  identities: readonly ProviderIdentity[],
): readonly ProviderIdentity[] =>
  [...new Map(identities.map((identity) => [identity.id, identity])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((identity) => structuredClone(identity));

const assertDisjoint = (
  providers: readonly AnalysisProvider[],
): ReadonlySet<string> => {
  const routes = new Set<string>();
  for (const provider of providers)
    for (const { operation } of provider.capabilities()) {
      if (routes.has(operation))
        throw new TypeError(
          `Multiple auxiliary providers declare operation ${operation}`,
        );
      routes.add(operation);
    }
  return routes;
};

const assertUniqueProviderIds = (
  identities: readonly ProviderIdentity[],
): void => {
  const ids = new Set<string>();
  for (const identity of identities) {
    if (ids.has(identity.id))
      throw new TypeError(`Duplicate configured provider ID: ${identity.id}`);
    ids.add(identity.id);
  }
};

const normalizeProfileResolution = (
  resolution: AnalysisProfileResolution,
  providerId: string,
): Result<AnalysisProfileResolution, ProviderAdapterError> => {
  try {
    return ok({
      profile:
        resolution.profile === null
          ? null
          : analysisProfileSchema.parse(resolution.profile),
      compatibility: jsonObjectSchema.parse(resolution.compatibility),
    });
  } catch (cause: unknown) {
    return err(
      new ProviderAdapterError(providerId, "resolve_analysis_profile", {
        cause,
      }),
    );
  }
};
