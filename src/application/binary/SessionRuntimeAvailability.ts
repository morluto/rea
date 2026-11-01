import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type { CapabilityDescriptor } from "../AnalysisProvider.js";

/** Failures of the provider adapter or process rather than of one request. */
const PROVIDER_WIDE_FAILURES: ReadonlySet<string> = new Set([
  "ProviderAdapterError",
  "HopperProcessError",
  "HopperStartError",
]);

interface RuntimeUnavailability {
  readonly reason: string;
  readonly providerId: string;
  /**
   * `observed`: a request for this operation failed or was refused.
   * `inferred`: another operation's provider-wide failure; no request for
   * this operation failed.
   */
  readonly basis: "observed" | "inferred";
  /** Dispatch order of the newest failed request this entry reflects. */
  readonly dispatch: number;
}

type RoutedOperation = Pick<
  CapabilityDescriptor,
  "operation" | "provider" | "available"
>;

/**
 * Own the runtime unavailability overlaid on the active route's declared
 * capabilities.
 *
 * Outcomes are ordered by dispatch to the provider client, not by completion:
 * a success clears only failures from requests dispatched before it, so an
 * older in-flight reply cannot erase a newer failure, while a request queued
 * behind a failure can clear it. Dispatch is the latest order this session
 * owns; it does not establish how a provider interleaves overlapping requests.
 */
export class SessionRuntimeAvailability {
  readonly #entries = new Map<string, RuntimeUnavailability>();
  #dispatched = 0;

  /** Current runtime unavailability keyed by operation. */
  get entries(): ReadonlyMap<string, { readonly reason: string }> {
    return this.#entries;
  }

  /** Order one request immediately before it reaches the provider client. */
  dispatch(): number {
    this.#dispatched += 1;
    return this.#dispatched;
  }

  /**
   * Apply one dispatched request's outcome and report whether visible
   * availability changed.
   *
   * A success clears its operation's earlier failures and the unavailability
   * its provider's earlier failures inferred for sibling operations. It
   * returns siblings to their declared availability without proving each is
   * healthy, and keeps failures observed for other operations.
   */
  observe(
    dispatch: number,
    capability: RoutedOperation,
    route: Iterable<RoutedOperation>,
    result: Result<unknown, AnalysisError>,
  ): boolean {
    const { operation } = capability;
    const providerId = capability.provider.id;
    if (result.ok) return this.#clearBefore(dispatch, operation, providerId);
    const failure = result.error;
    if (failure._tag === "AnalysisCapabilityUnavailableError")
      return this.#record(operation, {
        reason: failure.message,
        providerId,
        basis: "observed",
        dispatch,
      });
    if (!PROVIDER_WIDE_FAILURES.has(failure._tag)) return false;
    const reason = `${failure._tag}: ${failure.message}`;
    let changed = this.#record(operation, {
      reason,
      providerId,
      basis: "observed",
      dispatch,
    });
    const inferred = {
      reason: `Inferred from the ${operation} failure (${reason}). Retry after repairing the provider; a later successful ${providerId} request clears this.`,
      providerId,
      basis: "inferred" as const,
      dispatch,
    };
    // A declared refusal already explains its operation and is never dispatched.
    for (const sibling of route)
      if (
        sibling.available &&
        sibling.provider.id === providerId &&
        sibling.operation !== operation
      )
        changed = this.#record(sibling.operation, inferred) || changed;
    return changed;
  }

  /** Forget runtime outcomes when the active provider client is replaced. */
  clear(): boolean {
    if (this.#entries.size === 0) return false;
    this.#entries.clear();
    return true;
  }

  #clearBefore(
    dispatch: number,
    operation: string,
    providerId: string,
  ): boolean {
    let changed = false;
    for (const [name, entry] of this.#entries)
      if (
        entry.dispatch < dispatch &&
        (name === operation ||
          (entry.basis === "inferred" && entry.providerId === providerId))
      ) {
        this.#entries.delete(name);
        changed = true;
      }
    return changed;
  }

  #record(operation: string, next: RuntimeUnavailability): boolean {
    const current = this.#entries.get(operation);
    const entry = current === undefined ? next : mergeFailure(current, next);
    this.#entries.set(operation, entry);
    return current?.reason !== entry.reason;
  }
}

/**
 * An operation's own failure outlives provider-wide inference, and the merged
 * entry stays unavailable until a success dispatched after both.
 */
const mergeFailure = (
  current: RuntimeUnavailability,
  next: RuntimeUnavailability,
): RuntimeUnavailability => {
  const dispatch = Math.max(current.dispatch, next.dispatch);
  return current.basis === "observed" && next.basis === "inferred"
    ? { ...current, dispatch }
    : { ...next, dispatch };
};
