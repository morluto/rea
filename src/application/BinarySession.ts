import type { BinaryTarget } from "../domain/binaryTarget.js";
import { parseBinaryTarget } from "../domain/binaryTarget.js";
import {
  HopperCancelledError,
  NoBinaryOpenError,
  type HopperError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../hopper/protocol.js";
import type { HopperToolPort } from "./HopperToolPort.js";

/** A closeable Hopper port created for exactly one parsed target. */
export interface BinaryClient extends HopperToolPort {
  close(): Promise<void>;
}
/** Production seam for creating a target-scoped Hopper client. */
export type BinaryClientFactory = (target: BinaryTarget) => BinaryClient;

/** Serializes target transitions while allowing calls within the active session. */
export class BinarySession implements HopperToolPort {
  #active:
    | { readonly target: BinaryTarget; readonly client: BinaryClient }
    | undefined;
  #transition: Promise<void> = Promise.resolve();
  readonly #calls = new Set<Promise<unknown>>();
  constructor(readonly createClient: BinaryClientFactory) {}

  /** Open or switch to a target, retaining the old session when the new one fails. */
  open(
    path: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<BinaryTarget, HopperError>> {
    return this.#serialize(async () => {
      if (isAborted(options.signal)) return err(new HopperCancelledError());
      const parsed = await parseBinaryTarget(path);
      if (!parsed.ok) return parsed;
      if (isAborted(options.signal)) return err(new HopperCancelledError());
      if (this.#active?.target.path === parsed.value.path)
        return ok(parsed.value);
      await this.#drainCalls();
      const previous = this.#active;
      this.#active = undefined;
      await previous?.client.close();
      const client = this.createClient(parsed.value);
      const started = await client.callTool("health", {}, options);
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
  close(): Promise<Result<null, HopperError>> {
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
          format: target.format,
          kind: target.kind,
        };
  }

  /** Invoke a Hopper tool against the active target. */
  async callTool(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<JsonValue, HopperError>> {
    const transitioned = await this.#waitForTransition(options?.signal);
    if (!transitioned.ok) return transitioned;
    const active = this.#active;
    if (active === undefined) return err(new NoBinaryOpenError());
    const call = active.client.callTool(name, arguments_, options);
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
    await Promise.allSettled([...this.#calls]);
  }

  async #restore(
    previous:
      | { readonly target: BinaryTarget; readonly client: BinaryClient }
      | undefined,
  ): Promise<void> {
    if (previous === undefined) return;
    const client = this.createClient(previous.target);
    const started = await client.callTool("health", {});
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
