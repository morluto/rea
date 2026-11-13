/** One host owns these exact close capabilities; a released peer stays released. */
export class CapabilityScope {
  readonly #pending = new Map<string, () => Promise<void>>();
  #accepting = true;
  #closing: Promise<void> | undefined;

  constructor(readonly failureMessage = "REA provider cleanup failed") {}

  own<Value>(id: string, value: Value, close: () => Promise<void>): Value {
    if (!this.#accepting)
      throw new Error(`Cannot acquire capability ${id} after host shutdown`);
    if (this.#pending.has(id))
      throw new Error(`Capability ${id} already belongs to this host`);
    this.#pending.set(id, close);
    return value;
  }

  /** Join concurrent closes, retaining only failed owners for the next retry. */
  close(): Promise<void> {
    this.#accepting = false;
    this.#closing ??= Promise.allSettled(
      [...this.#pending].map(async ([id, close]) => {
        // A synchronous adapter throw must not prevent other owners' cleanup.
        await Promise.resolve().then(close);
        this.#pending.delete(id);
      }),
    )
      .then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, this.failureMessage);
      })
      .finally(() => {
        this.#closing = undefined;
      });
    return this.#closing;
  }
}
