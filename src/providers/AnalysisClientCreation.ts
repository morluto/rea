import { analysisClientFailureForOperation } from "./AnalysisClientFailure.js";
import {
  ArtifactResourceScope,
  ArtifactReaderFailure,
  bindArtifactFileCleanup,
  AnalysisCleanupLease,
} from "../resources/index.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type {
  AnalysisClient,
  RetainedResourceScope,
} from "../ports/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import {
  closedAnalysisClientError,
  ProviderAdapterError,
} from "../domain/providerAdapterError.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { err, ok, type Result } from "../domain/result.js";
import { SharedStartupAttempt } from "../process/SharedStartupAttempt.js";
import { closeAnalysisClient } from "./AnalysisClientCleanup.js";
import {
  retainCloseOutcome,
  type EngineCloseReport,
} from "../domain/engineCloseReport.js";

interface ClientLease {
  readonly client: AnalysisClient;
  readonly lease: AnalysisCleanupLease;
  /** The releasing close's report until a release outcome takes it. */
  report?: EngineCloseReport | null;
  failure?: AnalysisError;
}

/** Own deferred client creation while callers wait independently and close joins it. */
export class AnalysisClientCreation {
  readonly #inspectionResources = new ArtifactResourceScope();
  readonly #inspectionOwner = this.#inspectionResources.forCloseOwners();
  #attempt:
    | SharedStartupAttempt<Result<AnalysisClient, AnalysisError>>
    | undefined;
  #client: AnalysisClient | undefined;
  #failure: AnalysisError | undefined;
  #closed = false;
  /**
   * The close owner of one exact client, and the failure its last close
   * produced. External cleanup can settle that failure without the lease.
   */
  #clientLease: ClientLease | undefined;
  #closing:
    | Promise<Result<EngineCloseReport | null, AnalysisError>>
    | undefined;
  #closeOptions: Parameters<AnalysisClient["close"]>[0];

  constructor(
    private readonly providerId: string,
    private readonly create: (
      signal: AbortSignal,
      resourceOwner: RetainedResourceScope,
    ) => Promise<AnalysisClient>,
  ) {}

  get ownedClient(): AnalysisClient | undefined {
    return this.#client;
  }
  get readyClient(): AnalysisClient | undefined {
    return this.#closed ||
      this.#attempt !== undefined ||
      this.#failure !== undefined
      ? undefined
      : this.#client;
  }
  get reusable(): boolean {
    return (
      !this.#closed &&
      this.#attempt === undefined &&
      this.#failure === undefined &&
      !this.#clientReleased()
    );
  }

  /** Whether the leased client is gone: its lease or its settled close released it. */
  #clientReleased(): boolean {
    const entry = this.#clientLease;
    return (
      entry !== undefined &&
      (entry.lease.released ||
        (entry.failure !== undefined && !entry.failure.cleanupIncomplete))
    );
  }
  async acquire(
    operation: string,
    signal?: AbortSignal,
  ): Promise<Result<AnalysisClient, AnalysisError>> {
    if (signal?.aborted) return err(cancelledBy(operation, signal));
    if (this.#closed)
      return err(closedAnalysisClientError(this.providerId, operation));
    if (this.#failure?.cleanupIncomplete)
      return err(
        analysisClientFailureForOperation(
          this.#failure,
          this.providerId,
          operation,
        ),
      );
    const ready = this.readyClient;
    if (ready !== undefined && !this.#clientReleased()) return ok(ready);
    if (this.#clientReleased()) {
      this.#client = undefined;
      this.#clientLease = undefined;
    }
    let attempt = this.#attempt;
    const draining = attempt?.signal.aborted === true;
    if (attempt === undefined) {
      this.#failure = undefined;
      attempt = new SharedStartupAttempt((ownerSignal) =>
        Promise.resolve().then(() => this.#createOwned(ownerSignal)),
      );
      const owned = attempt;
      this.#attempt = owned;
      void owned.promise.then((result) => {
        if (this.#attempt !== owned) return;
        if (!result.ok) this.#failure = result.error;
        this.#attempt = undefined;
      });
    }
    const waited = await attempt.wait(signal);
    if (waited.status === "cancelled")
      return err(cancelledBy(operation, carriedReason(waited.reason)));
    if (
      draining &&
      !signal?.aborted &&
      !waited.value.ok &&
      waited.value.error instanceof AnalysisCancelledError &&
      !waited.value.error.cleanupIncomplete &&
      waited.value.error.cause === attempt.signal.reason
    )
      return this.acquire(operation, signal);
    if (!waited.value.ok)
      return err(
        analysisClientFailureForOperation(
          waited.value.error,
          this.providerId,
          operation,
        ),
      );
    if (signal?.aborted) return err(cancelledBy(operation, signal));
    return waited.value;
  }

  async #createOwned(
    signal: AbortSignal,
  ): Promise<Result<AnalysisClient, AnalysisError>> {
    if (signal.aborted)
      return err(cancelledBy("create_analysis_client", signal));
    let primary: AnalysisError | undefined;
    try {
      this.#client = await this.create(signal, this.#inspectionOwner);
    } catch (cause: unknown) {
      primary =
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(
              this.providerId,
              "create_analysis_client",
              { cause },
            );
    }
    const inspections = await this.#cleanupInspectionResources(() =>
      this.#inspectionResources.retryCleanup(),
    );
    if (signal.aborted && primary === undefined)
      primary = cancelledBy("create_analysis_client", signal);
    if (!inspections.ok)
      primary =
        primary === undefined
          ? inspections.error
          : analysisErrorWithCleanupDependencies(
              primary,
              inspections.error,
              "create_analysis_client",
            );
    if (primary !== undefined) {
      const closed = await this.#releaseClient(this.#closeOptions);
      return err(
        closed.ok
          ? primary
          : analysisErrorWithCleanupDependencies(
              primary,
              closed.error,
              "create_analysis_client",
            ),
      );
    }
    if (this.#client === undefined)
      throw new Error("Client creation completed without a client");
    return ok(this.#client);
  }

  async #cleanupInspectionResources(
    cleanup: () => Promise<void>,
  ): Promise<Result<null, AnalysisError>> {
    try {
      await cleanup();
      return ok(null);
    } catch (cause: unknown) {
      const observation = ArtifactReaderFailure.cleanupObservation(
        cause,
        "client prerequisite resources",
      );
      const failure = new ProviderCleanupError(
        this.providerId,
        observation.resources,
        { reason: observation.reason },
        { cause, operation: "create_analysis_client" },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
  }

  close(
    options?: Parameters<AnalysisClient["close"]>[0],
  ): Promise<Result<EngineCloseReport | null, AnalysisError>> {
    this.#closed = true;
    this.#closeOptions = options;
    this.#attempt?.close();
    this.#closing ??= Promise.resolve()
      .then(async () => {
        await this.#attempt?.promise;
        const inspections = await this.#cleanupInspectionResources(() =>
          this.#inspectionResources.close(),
        );
        const inspectionFailure = inspections.ok
          ? undefined
          : inspections.error;
        const closed = await this.#releaseClient(this.#closeOptions);
        // What the client's close completed stays with this close's outcome.
        if (!closed.ok && inspectionFailure !== undefined)
          return err(
            retainCloseOutcome(
              analysisErrorWithCleanupDependencies(
                closed.error,
                inspectionFailure,
                "create_analysis_client",
              ),
              closed,
            ),
          );
        if (!closed.ok) return closed;
        if (inspectionFailure !== undefined)
          return err(retainCloseOutcome(inspectionFailure, closed));
        return this.#failure?.cleanupIncomplete
          ? err(retainCloseOutcome(this.#failure, closed))
          : closed;
      })
      .finally(() => {
        this.#closing = undefined;
      });
    return this.#closing;
  }

  async #releaseClient(
    options: Parameters<AnalysisClient["close"]>[0],
  ): Promise<Result<EngineCloseReport | null, AnalysisError>> {
    if (this.#client === undefined) return ok(null);
    const client = this.#client;
    if (options !== undefined) this.#closeOptions = options;
    if (this.#clientLease?.client !== client) this.#clientLease = undefined;
    // The lease owns release; the report of the close that released the
    // client is handed to one release outcome.
    if (this.#clientLease === undefined) {
      const created: ClientLease = {
        client,
        lease: new AnalysisCleanupLease(async () => {
          const result = await closeAnalysisClient(
            client,
            this.providerId,
            this.#closeOptions,
          );
          if (!result.ok) throw result.error;
          created.report = result.value;
        }),
      };
      this.#clientLease = created;
    }
    const entry = this.#clientLease;
    const clientLease = entry.lease;
    try {
      await clientLease.release();
      const report = entry.report ?? null;
      entry.report = null;
      return ok(report);
    } catch (cause: unknown) {
      const failure = new ProviderCleanupError(
        this.providerId,
        cause instanceof AnalysisError && cause.cleanupResources.length > 0
          ? cause.cleanupResources
          : ["provider-client"],
        {
          reason:
            "Client creation retains its exact client until close confirms release",
          ...(cause instanceof AnalysisError
            ? { client_close_failure: projectAnalysisError(cause) }
            : {}),
        },
        {
          cause,
          operation: "create_analysis_client",
          // The client knows what its retained close needs; keep that advice
          // and the control that stopped the close on the failure the caller
          // reads.
          ...(cause instanceof ProviderAdapterError &&
          cause.remediationAction !== undefined
            ? { remediationAction: cause.remediationAction }
            : {}),
          ...(cause instanceof AnalysisError && cause.limit !== undefined
            ? { limit: cause.limit }
            : {}),
        },
      );
      if (cause instanceof AnalysisError && cause.hasCleanupOwner) {
        failure.bindCleanupResourceOwner({
          get cleanupResources() {
            return clientLease.released || !cause.cleanupIncomplete
              ? []
              : cause.cleanupResources;
          },
        });
        failure.bindCleanupReleaseClaim({
          get cleanupReleased() {
            return !cause.cleanupIncomplete;
          },
        });
      } else {
        failure.bindCleanupResourceOwner(clientLease);
      }
      clientLease.bindCleanupError(failure);
      entry.failure = failure;
      return err(
        cause instanceof AnalysisError
          ? retainCloseOutcome(failure, err(cause))
          : failure,
      );
    }
  }
}
