import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { ProviderOperationHealth } from "../../domain/providerOperationHealth.js";
import { err, ok } from "../../domain/result.js";
import { ABORTED, waitForAbortable } from "./AbortablePromise.js";
import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
  ProviderRequestActivitySnapshot,
  ProviderRuntimeLineageSnapshot,
} from "../AnalysisProvider.js";

type LoadAnalysisProvider = () => Promise<AnalysisProvider>;

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/**
 * Preserve synchronous provider discovery while loading implementation modules
 * only when a target-bound client first executes.
 */
export class LazyAnalysisProvider implements AnalysisProvider {
  readonly #providerIdentity: ProviderIdentity;
  readonly #capabilityDescriptors: readonly CapabilityDescriptor[];
  readonly #loadProvider: LoadAnalysisProvider;
  #provider: Promise<AnalysisProvider> | undefined;

  constructor(options: {
    readonly identity: ProviderIdentity;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly load: LoadAnalysisProvider;
  }) {
    this.#providerIdentity = options.identity;
    this.#capabilityDescriptors = options.capabilities;
    this.#loadProvider = options.load;
  }

  /** Return source-declared provider identity without loading its implementation. */
  identity(): ProviderIdentity {
    return this.#providerIdentity;
  }

  /** Return source-declared capability metadata without loading its implementation. */
  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilityDescriptors;
  }

  /** Create a client whose implementation is loaded on first execution. */
  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    return new LazyAnalysisClient(async () => {
      const provider = await this.#load();
      return provider.createClient(target, profile, context);
    }, this.#providerIdentity.id);
  }

  async #load(): Promise<AnalysisProvider> {
    this.#provider ??= this.#loadProvider().catch((cause: unknown) => {
      this.#provider = undefined;
      throw cause;
    });
    return this.#provider;
  }
}

class LazyAnalysisClient implements AnalysisClient {
  readonly #loadClient: () => Promise<AnalysisClient>;
  readonly #providerId: string;
  #client: AnalysisClient | undefined;
  #loading: Promise<AnalysisClient> | undefined;
  #closed = false;

  constructor(loadClient: () => Promise<AnalysisClient>, providerId: string) {
    this.#loadClient = loadClient;
    this.#providerId = providerId;
  }

  execute: AnalysisClient["execute"] = async (
    operation,
    parameters,
    options,
  ) => {
    try {
      if (isAborted(options?.signal))
        return err(new AnalysisCancelledError(operation));
      const loaded = await waitForAbortable(
        this.#load(operation),
        options?.signal,
      );
      if (loaded === ABORTED) return err(new AnalysisCancelledError(operation));
      return await loaded.execute(operation, parameters, options);
    } catch (cause: unknown) {
      if (cause instanceof AnalysisError) return err(cause);
      return err(
        new ProviderAdapterError(this.#providerId, operation, {
          cause,
        }),
      );
    }
  };

  runtimeLineageSnapshots(): readonly ProviderRuntimeLineageSnapshot[] {
    return this.#client?.runtimeLineageSnapshots?.() ?? [];
  }

  requestActivitySnapshots(): readonly ProviderRequestActivitySnapshot[] {
    return this.#client?.requestActivitySnapshots?.() ?? [];
  }

  operationHealthSnapshot(): ProviderOperationHealth | undefined {
    return this.#client?.operationHealthSnapshot?.();
  }

  close: AnalysisClient["close"] = async (options) => {
    this.#closed = true;
    if (this.#loading === undefined) return ok(null);
    const client = await this.#loading;
    return client.close(options);
  };

  async #load(operation: string): Promise<AnalysisClient> {
    if (this.#closed)
      throw new ProviderAdapterError(this.#providerId, operation, {
        diagnostics: { reason: "client_closed" },
      });
    this.#loading ??= this.#loadClient()
      .then((client) => {
        this.#client = client;
        return client;
      })
      .catch((cause: unknown) => {
        this.#loading = undefined;
        throw cause;
      });
    return this.#loading;
  }
}
