import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  HopperCancelledError,
  NoBinaryOpenError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  AnalysisClient,
  AnalysisClientFactory,
  AnalysisOperationPort,
  AnalysisProvider,
} from "./AnalysisProvider.js";

/** Target lifecycle used by CLI and MCP without exposing a concrete provider. */
export interface BinarySessionPort extends AnalysisOperationPort {
  open(
    path: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
    },
  ): Promise<Result<BinaryTarget, AnalysisError>>;
  close(): Promise<Result<null, AnalysisError>>;
  status(): JsonValue;
  activeTarget(): BinaryTarget | undefined;
}

/**
 * Owns the single active target shared by CLI and MCP adapters.
 *
 * Target transitions are serialized because each client dispatches Hopper API
 * work on its dedicated Python thread, and switching targets tears that bridge
 * down. A failed switch recreates the previous target instead of retaining a
 * client whose bridge was already shut down.
 */
export class BinarySession implements BinarySessionPort {
  #active:
    | { readonly target: BinaryTarget; readonly client: AnalysisClient }
    | undefined;
  #transition: Promise<void> = Promise.resolve();
  readonly #calls = new Set<Promise<unknown>>();
  readonly #createClient: AnalysisClientFactory;

  constructor(readonly provider: AnalysisProvider | AnalysisClientFactory) {
    this.#createClient =
      typeof provider === "function"
        ? provider
        : (target) => provider.createClient(target);
  }

  /**
   * Open or switch targets after draining calls against the current target.
   * Returns the switch failure even if best-effort restoration also fails.
   */
  open(
    path: string,
    options: {
      readonly signal?: AbortSignal;
      readonly targetKind?: BinaryTarget["kind"];
    } = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    return this.#serialize(async () => {
      if (isAborted(options.signal)) return err(new HopperCancelledError());
      const parsed = await parseBinaryTarget(
        path,
        process.cwd(),
        process.arch,
        options.targetKind,
      );
      if (!parsed.ok) return parsed;
      if (isAborted(options.signal)) return err(new HopperCancelledError());
      if (this.#active?.target.path === parsed.value.path)
        return ok(parsed.value);
      await this.#drainCalls();
      const previous = this.#active;
      this.#active = undefined;
      await previous?.client.close();
      const client = this.#createClient(parsed.value);
      const started = await client.execute("health", {}, options);
      if (!started.ok) {
        await client.close();
        await this.#restore(previous);
        return started;
      }
      if (isAborted(options.signal)) {
        await client.close();
        await this.#restore(previous);
        return err(new HopperCancelledError());
      }
      this.#active = { target: parsed.value, client };
      return ok(parsed.value);
    });
  }

  /** Close the active target, if any. */
  close(): Promise<Result<null, AnalysisError>> {
    return this.#serialize(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await this.#drainCalls();
      await previous?.client.close();
      return ok(null);
    });
  }

  /** Describe the active binary session. */
  status(): JsonValue {
    const target = this.#active?.target;
    return target === undefined
      ? { open: false }
      : {
          open: true,
          path: target.path,
          sha256: target.sha256,
          format: target.format,
          kind: target.kind,
          architecture: target.architecture ?? null,
        };
  }

  /** Return the immutable artifact identity captured before Hopper launched. */
  activeTarget(): BinaryTarget | undefined {
    return this.#active?.target;
  }

  /**
   * Invoke a Hopper tool against the active target.
   * Calls may overlap, but a pending target transition prevents new calls from
   * entering until the transition has settled.
   */
  async execute(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<JsonValue, AnalysisError>> {
    const transitioned = await this.#waitForTransition(options?.signal);
    if (!transitioned.ok) return transitioned;
    const active = this.#active;
    if (active === undefined) return err(new NoBinaryOpenError());
    const call = active.client.execute(name, arguments_, options);
    this.#calls.add(call);
    try {
      return await call;
    } finally {
      this.#calls.delete(call);
    }
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
      | { readonly target: BinaryTarget; readonly client: AnalysisClient }
      | undefined,
  ): Promise<void> {
    if (previous === undefined) return;
    const client = this.#createClient(previous.target);
    const started = await client.execute("health", {});
    if (started.ok) this.#active = { target: previous.target, client };
    else await client.close();
  }

  async #waitForTransition(
    signal?: AbortSignal,
  ): Promise<Result<undefined, HopperCancelledError>> {
    if (signal?.aborted === true) return err(new HopperCancelledError());
    if (signal === undefined) {
      await this.#transition;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(err(new HopperCancelledError()));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#transition.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted ? err(new HopperCancelledError()) : ok(undefined),
          );
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(
            signal.aborted ? err(new HopperCancelledError()) : ok(undefined),
          );
        },
      );
    });
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
