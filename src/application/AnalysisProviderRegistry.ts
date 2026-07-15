import {
  analysisProviderIdSchema,
  analysisProviderSelectorSchema,
  type AnalysisProviderSelector,
} from "../contracts/providerSelection.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  ProviderSelectionError,
  type ProviderSelectionFailureReason,
  type ProviderSelectionRejection,
} from "../domain/errors.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "./AnalysisProvider.js";
import {
  evaluateAnalysisProviderCandidate,
  type AnalysisProviderCandidateEvaluation,
} from "./AnalysisProviderEvaluation.js";

/** Deterministic discovery truth for one configured deep provider. */
export interface AnalysisProviderCandidateStatus {
  readonly provider: ProviderIdentity;
  readonly availability: ProviderAvailability;
  readonly targetSupport:
    | ProviderTargetSupport
    | {
        /** No target has been parsed, so support has not been evaluated. */
        readonly status: "unknown";
        readonly code: null;
        readonly reason: string;
        readonly diagnostics: Readonly<Record<string, JsonValue>>;
      };
  readonly selected: boolean;
  readonly capabilities: readonly CapabilityDescriptor[];
}

/** One immutable deep-provider binding selected before client startup. */
export interface AnalysisProviderBinding {
  readonly provider: AnalysisProviderCandidate;
  readonly identity: ProviderIdentity & { readonly version: string };
  readonly selectionSource: "request" | "environment" | "auto-single-candidate";
  readonly profile: AnalysisProfileCommitment;
  readonly compatibility: Readonly<Record<string, JsonValue>>;
}

/** Complete result used for both a bound and intentionally unbound target. */
export interface AnalysisProviderSelection {
  readonly requestedProviderId: string;
  readonly binding: AnalysisProviderBinding | null;
  readonly candidates: readonly AnalysisProviderCandidateStatus[];
}

interface TargetSelectionContext {
  readonly target: BinaryTarget;
  readonly baseline: readonly AnalysisProviderCandidateStatus[];
  readonly signal: AbortSignal | undefined;
}

/**
 * Discover and select overlapping deep providers without starting their clients.
 * Registration order never affects selection or caller-visible output.
 */
export class AnalysisProviderRegistry {
  readonly #providers: readonly AnalysisProviderCandidate[];
  readonly #byId: ReadonlyMap<string, AnalysisProviderCandidate>;
  readonly #declaredOperations: readonly string[];
  readonly #defaultSelector: AnalysisProviderSelector;

  constructor(
    providers: readonly AnalysisProviderCandidate[],
    defaultSelector: AnalysisProviderSelector = "auto",
  ) {
    this.#defaultSelector =
      analysisProviderSelectorSchema.parse(defaultSelector);
    const byId = new Map<string, AnalysisProviderCandidate>();
    const declaredOperations = new Set<string>();
    for (const provider of providers) {
      const identity = provider.identity();
      if (!analysisProviderIdSchema.safeParse(identity.id).success)
        throw new TypeError(`Invalid analysis provider ID: ${identity.id}`);
      if (byId.has(identity.id))
        throw new TypeError(`Duplicate analysis provider ID: ${identity.id}`);
      const providerOperations = new Set<string>();
      for (const capability of provider.capabilities()) {
        if (
          capability.provider.id !== identity.id ||
          capability.provider.name !== identity.name ||
          capability.provider.version !== identity.version
        )
          throw new TypeError(
            `Provider ${identity.id} published mismatched capability provenance for ${capability.operation}`,
          );
        if (providerOperations.has(capability.operation))
          throw new TypeError(
            `Provider ${identity.id} declares operation ${capability.operation} more than once`,
          );
        providerOperations.add(capability.operation);
        declaredOperations.add(capability.operation);
      }
      byId.set(identity.id, provider);
    }
    this.#providers = Object.freeze(
      [...providers].sort((left, right) =>
        left.identity().id.localeCompare(right.identity().id),
      ),
    );
    this.#byId = byId;
    this.#declaredOperations = Object.freeze(
      [...declaredOperations].sort((left, right) => left.localeCompare(right)),
    );
  }

  /** Return the configured default without interpreting it as priority. */
  defaultSelector(): AnalysisProviderSelector {
    return this.#defaultSelector;
  }

  /** List configured candidate identities in canonical provider-ID order. */
  identities(): readonly ProviderIdentity[] {
    return this.#providers.map((provider) =>
      structuredClone(provider.identity()),
    );
  }

  /** List the unique deep-operation declarations without probing candidates. */
  declaredOperations(): readonly string[] {
    return [...this.#declaredOperations];
  }

  /** Discover candidates for status without resolving profiles or starting clients. */
  candidates(
    target?: BinaryTarget,
  ): readonly AnalysisProviderCandidateStatus[] {
    return this.#providers.map((provider) => candidateStatus(provider, target));
  }

  /** Select one whole deep-operation family for a parsed target. */
  async select(
    target: BinaryTarget,
    requestedSelector?: AnalysisProviderSelector,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    Result<
      AnalysisProviderSelection,
      ProviderSelectionError | AnalysisCancelledError
    >
  > {
    if (signalIsAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const parsedRequest =
      requestedSelector === undefined
        ? undefined
        : analysisProviderSelectorSchema.safeParse(requestedSelector);
    if (parsedRequest !== undefined && !parsedRequest.success)
      return err(
        selectionError(
          "invalid_options",
          typeof requestedSelector === "string"
            ? requestedSelector
            : "<invalid>",
          this.candidates(target),
        ),
      );
    const request = parsedRequest?.data;
    const selector = request ?? this.#defaultSelector;
    const baseline = this.candidates(target);
    if (signalIsAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    if (
      request === undefined &&
      selector !== "auto" &&
      baseline.length > 0 &&
      baseline.every(
        ({ targetSupport }) => targetSupport.status === "unsupported",
      )
    )
      return ok({
        requestedProviderId: selector,
        binding: null,
        candidates: baseline,
      });
    if (selector !== "auto")
      return this.#selectConcrete(
        { target, baseline, signal: options.signal },
        selector,
        request === undefined ? "environment" : "request",
      );
    return this.#selectAutomatically({
      target,
      baseline,
      signal: options.signal,
    });
  }

  /** Explain why a deep operation is unavailable on an unbound target. */
  unboundOperationError(
    operation: string,
    selection: AnalysisProviderSelection,
  ): ProviderSelectionError {
    const reason: ProviderSelectionFailureReason =
      selection.candidates.length > 0 &&
      selection.candidates.every(
        ({ targetSupport }) => targetSupport.status === "unsupported",
      )
        ? "target_unsupported"
        : "provider_unavailable";
    return selectionError(
      reason,
      selection.requestedProviderId,
      selection.candidates,
      operation,
    );
  }

  async #selectConcrete(
    context: TargetSelectionContext,
    providerId: string,
    source: AnalysisProviderBinding["selectionSource"],
  ): Promise<
    Result<
      AnalysisProviderSelection,
      ProviderSelectionError | AnalysisCancelledError
    >
  > {
    const { baseline, signal, target } = context;
    const provider = this.#byId.get(providerId);
    if (provider === undefined)
      return err(selectionError("unknown_provider", providerId, baseline));
    const initial = baseline.find(
      ({ provider: identity }) => identity.id === providerId,
    );
    if (initial === undefined)
      throw new TypeError(
        "Registered provider is absent from discovery output",
      );
    if (initial.targetSupport.status !== "supported")
      return err(selectionError("target_unsupported", providerId, baseline));
    if (initial.availability.status === "unavailable")
      return err(selectionError("provider_unavailable", providerId, baseline));
    const evaluation = await evaluateAnalysisProviderCandidate(
      provider,
      initial,
      target,
      signal,
    );
    if (!evaluation.ok) return evaluation;
    const evaluated = evaluation.value;
    const statuses = replaceCandidate(baseline, evaluated.status);
    if (
      evaluated.profile === undefined ||
      evaluated.compatibility === undefined
    )
      return err(selectionError("provider_unavailable", providerId, statuses));
    return ok(
      selectedResult(
        providerId,
        source,
        {
          ...evaluated,
          profile: evaluated.profile,
          compatibility: evaluated.compatibility,
        },
        statuses,
      ),
    );
  }

  async #selectAutomatically(
    context: TargetSelectionContext,
  ): Promise<
    Result<
      AnalysisProviderSelection,
      ProviderSelectionError | AnalysisCancelledError
    >
  > {
    const { baseline, signal, target } = context;
    const results = await Promise.all(
      this.#providers.map(
        async (
          provider,
        ): Promise<
          Result<AnalysisProviderCandidateEvaluation, AnalysisCancelledError>
        > => {
          const status = baseline.find(
            ({ provider: identity }) => identity.id === provider.identity().id,
          );
          if (status === undefined)
            throw new TypeError(
              "Registered provider is absent from discovery output",
            );
          return status.availability.status === "available" &&
            status.targetSupport.status === "supported"
            ? evaluateAnalysisProviderCandidate(
                provider,
                status,
                target,
                signal,
              )
            : ok({
                candidate: provider,
                status,
              } satisfies AnalysisProviderCandidateEvaluation);
        },
      ),
    );
    const cancelled = results.find((result) => !result.ok);
    if (cancelled !== undefined && !cancelled.ok) return cancelled;
    const evaluations = results.map((result) => {
      if (!result.ok)
        throw new TypeError("Cancelled candidate evaluation disappeared");
      return result.value;
    });
    const statuses = evaluations.map(({ status }) => status);
    const usable = evaluations.filter(
      (
        evaluation,
      ): evaluation is AnalysisProviderCandidateEvaluation & {
        readonly profile: AnalysisProfileCommitment;
        readonly compatibility: Readonly<Record<string, JsonValue>>;
      } =>
        evaluation.profile !== undefined &&
        evaluation.compatibility !== undefined,
    );
    if (usable.length === 0)
      return ok({
        requestedProviderId: "auto",
        binding: null,
        candidates: statuses,
      });
    if (usable.length > 1)
      return err(selectionError("ambiguous", "auto", statuses));
    const selected = usable[0];
    if (selected === undefined)
      throw new TypeError("Usable provider selection disappeared");
    return ok(
      selectedResult("auto", "auto-single-candidate", selected, statuses),
    );
  }
}

const candidateStatus = (
  provider: AnalysisProviderCandidate,
  target: BinaryTarget | undefined,
): AnalysisProviderCandidateStatus => ({
  provider: structuredClone(provider.identity()),
  availability: cloneAvailability(provider.inspectAvailability()),
  targetSupport:
    target === undefined
      ? {
          status: "unknown",
          code: null,
          reason: "No target is open.",
          diagnostics: {},
        }
      : cloneTargetSupport(provider.inspectTargetSupport(target)),
  selected: false,
  capabilities: provider
    .capabilities()
    .map((capability) => structuredClone(capability)),
});

const signalIsAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const selectedResult = (
  requestedProviderId: string,
  source: AnalysisProviderBinding["selectionSource"],
  evaluated: AnalysisProviderCandidateEvaluation & {
    readonly profile: AnalysisProfileCommitment;
    readonly compatibility: Readonly<Record<string, JsonValue>>;
  },
  statuses: readonly AnalysisProviderCandidateStatus[],
): AnalysisProviderSelection => {
  const selectedStatus = {
    ...evaluated.status,
    provider: structuredClone(evaluated.profile.provider),
    selected: true,
  } satisfies AnalysisProviderCandidateStatus;
  return {
    requestedProviderId,
    binding: {
      provider: evaluated.candidate,
      identity: structuredClone(evaluated.profile.provider),
      selectionSource: source,
      profile: structuredClone(evaluated.profile),
      compatibility: structuredClone(evaluated.compatibility),
    },
    candidates: replaceCandidate(statuses, selectedStatus),
  };
};

const replaceCandidate = (
  statuses: readonly AnalysisProviderCandidateStatus[],
  replacement: AnalysisProviderCandidateStatus,
): readonly AnalysisProviderCandidateStatus[] =>
  statuses.map((status) =>
    status.provider.id === replacement.provider.id ? replacement : status,
  );

const selectionError = (
  reason: ProviderSelectionFailureReason,
  requestedProviderId: string,
  candidates: readonly AnalysisProviderCandidateStatus[],
  operation = "open_binary",
): ProviderSelectionError =>
  new ProviderSelectionError({
    operation,
    reason,
    requestedProviderId,
    candidateIds: candidates.map(({ provider }) => provider.id),
    rejections: candidateRejections(candidates),
  });

const candidateRejections = (
  candidates: readonly AnalysisProviderCandidateStatus[],
): readonly ProviderSelectionRejection[] =>
  candidates.flatMap((candidate) =>
    [
      ...(candidate.availability.status === "unavailable"
        ? [candidate.availability]
        : []),
      ...(candidate.targetSupport.status === "unsupported"
        ? [candidate.targetSupport]
        : []),
    ].map((rejection) => ({
      providerId: candidate.provider.id,
      code: rejection.code,
      reason: rejection.reason,
      diagnostics: structuredClone(rejection.diagnostics),
    })),
  );

const cloneAvailability = (
  availability: ProviderAvailability,
): ProviderAvailability => ({
  ...availability,
  diagnostics: jsonObjectSchema.parse(availability.diagnostics),
});

const cloneTargetSupport = (
  support: ProviderTargetSupport,
): ProviderTargetSupport => ({
  ...support,
  diagnostics: jsonObjectSchema.parse(support.diagnostics),
});
