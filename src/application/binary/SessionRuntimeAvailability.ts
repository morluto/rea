import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { Result } from "../../domain/result.js";
import type { CapabilityDescriptor } from "../AnalysisProvider.js";

/** Failures of the provider adapter or process rather than of one request. */
const PROVIDER_WIDE_FAILURES: ReadonlySet<string> = new Set([
  "ProviderAdapterError",
  "HopperProcessError",
  "HopperStartError",
]);

interface Failure {
  readonly dispatch: number;
  readonly reason: string;
}

interface ProviderFailure extends Failure {
  readonly operation: string;
}

/** Newest failure and newest success, both by dispatch, for one owner. */
interface Outcomes<F extends Failure> {
  failure: F | undefined;
  succeeded: number;
}

type RoutedOperation = Pick<
  CapabilityDescriptor,
  "operation" | "provider" | "available"
>;

/** Reason recorded for an operation's own refusal or provider-wide failure. */
const runtimeFailureReason = (failure: AnalysisError): string | undefined => {
  if (failure._tag === "AnalysisCapabilityUnavailableError")
    return failure.userMessage ?? failure.message;
  return PROVIDER_WIDE_FAILURES.has(failure._tag)
    ? `${failure._tag}: ${failure.message}`
    : undefined;
};

/** Explain unavailability inferred for an operation no request failed for. */
const inferredUnavailabilityReason = (
  providerId: string,
  failure: Pick<ProviderFailure, "operation" | "reason">,
): string =>
  `Inferred from the ${failure.operation} failure (${failure.reason}). Retry after repairing the provider; a later successful ${providerId} request clears this.`;

/**
 * Own the runtime unavailability overlaid on the active route's declared
 * capabilities.
 *
 * An operation is unavailable while its newest refusal or provider-wide
 * failure was dispatched after its newest success. A declared-available
 * operation is also unavailable, as inferred, while its provider's newest
 * provider-wide failure was dispatched after any success from that provider.
 * One success therefore returns inferred siblings to their declared
 * availability without proving each is healthy, and keeps failures observed
 * for other operations.
 *
 * Only the newest dispatch of each outcome matters, so the projection does not
 * depend on the order in which overlapping replies complete. Dispatch is the
 * latest order this session owns; it does not establish how a provider
 * interleaves overlapping requests.
 */
export class SessionRuntimeAvailability {
  readonly #operations = new Map<string, Outcomes<Failure>>();
  readonly #providers = new Map<string, Outcomes<ProviderFailure>>();
  #projected: ReadonlyMap<string, { readonly reason: string }> = new Map();
  #dispatched = 0;

  /** Current runtime unavailability keyed by operation. */
  get entries(): ReadonlyMap<string, { readonly reason: string }> {
    return this.#projected;
  }

  /** Order one request immediately before it reaches the provider client. */
  dispatch(): number {
    this.#dispatched += 1;
    return this.#dispatched;
  }

  /**
   * Record one dispatched request's outcome against the route it ran on and
   * report whether visible availability changed.
   */
  observe(
    dispatch: number,
    capability: RoutedOperation,
    route: Iterable<RoutedOperation>,
    result: Result<unknown, AnalysisError>,
  ): boolean {
    const operation = outcomes(this.#operations, capability.operation);
    const provider = outcomes(this.#providers, capability.provider.id);
    if (result.ok) {
      operation.succeeded = Math.max(operation.succeeded, dispatch);
      provider.succeeded = Math.max(provider.succeeded, dispatch);
      const siblingUnavailability =
        typeof result.value === "object" &&
        result.value !== null &&
        "siblingUnavailability" in result.value &&
        result.value.siblingUnavailability instanceof
          AnalysisCapabilityUnavailableError
          ? result.value.siblingUnavailability
          : undefined;
      if (siblingUnavailability !== undefined) {
        this.#observeSiblingUnavailability(
          dispatch,
          capability.operation,
          siblingUnavailability,
        );
      } else if (this.#projected.size === 0) {
        return false;
      }
    } else {
      const reason = runtimeFailureReason(result.error);
      if (reason === undefined) return false;
      operation.failure = newer(operation.failure, { dispatch, reason });
      if (
        result.error instanceof AnalysisCapabilityUnavailableError &&
        result.error.siblingOperations !== undefined
      ) {
        this.#observeSiblingUnavailability(
          dispatch,
          capability.operation,
          result.error,
        );
      }
      if (PROVIDER_WIDE_FAILURES.has(result.error._tag))
        provider.failure = newer(provider.failure, {
          dispatch,
          reason,
          operation: capability.operation,
        });
    }
    return this.#project(route);
  }

  #observeSiblingUnavailability(
    dispatch: number,
    currentOperation: string,
    error: AnalysisCapabilityUnavailableError,
  ): void {
    if (error.siblingOperations === undefined) return;
    for (const sibling of error.siblingOperations) {
      if (sibling !== currentOperation) {
        const siblingOutcomes = outcomes(this.#operations, sibling);
        const activeFailure =
          siblingOutcomes.failure !== undefined &&
          siblingOutcomes.failure.dispatch > siblingOutcomes.succeeded
            ? siblingOutcomes.failure
            : undefined;
        const reason =
          activeFailure?.reason ??
          error.siblingReasons?.[sibling] ??
          (error.remediationAction !== undefined
            ? `Provider ${error.providerId} cannot execute ${sibling}: ${error.reason}. ${error.remediationAction}`
            : `Provider ${error.providerId} cannot execute ${sibling}: ${error.reason}`);
        siblingOutcomes.failure = newer(siblingOutcomes.failure, {
          dispatch,
          reason,
        });
      }
    }
  }

  /** Forget runtime outcomes when the active provider client is replaced. */
  clear(): boolean {
    this.#operations.clear();
    this.#providers.clear();
    if (this.#projected.size === 0) return false;
    this.#projected = new Map();
    return true;
  }

  #project(route: Iterable<RoutedOperation>): boolean {
    const projected = new Map<string, { readonly reason: string }>();
    for (const descriptor of route) {
      const reason = this.#unavailableReason(descriptor);
      if (reason !== undefined) projected.set(descriptor.operation, { reason });
    }
    const changed =
      projected.size !== this.#projected.size ||
      [...projected].some(
        ([operation, { reason }]) =>
          this.#projected.get(operation)?.reason !== reason,
      );
    this.#projected = projected;
    return changed;
  }

  #unavailableReason(descriptor: RoutedOperation): string | undefined {
    const operation = this.#operations.get(descriptor.operation);
    if (
      operation?.failure !== undefined &&
      operation.failure.dispatch > operation.succeeded
    )
      return operation.failure.reason;
    // A declared refusal already explains its operation and is never dispatched.
    if (!descriptor.available) return undefined;
    const provider = this.#providers.get(descriptor.provider.id);
    return provider?.failure !== undefined &&
      provider.failure.dispatch > provider.succeeded
      ? inferredUnavailabilityReason(descriptor.provider.id, provider.failure)
      : undefined;
  }
}

const outcomes = <F extends Failure>(
  owners: Map<string, Outcomes<F>>,
  key: string,
): Outcomes<F> => {
  const existing = owners.get(key);
  if (existing !== undefined) return existing;
  const created: Outcomes<F> = { failure: undefined, succeeded: 0 };
  owners.set(key, created);
  return created;
};

const newer = <F extends Failure>(current: F | undefined, next: F): F =>
  current !== undefined && current.dispatch > next.dispatch ? current : next;
