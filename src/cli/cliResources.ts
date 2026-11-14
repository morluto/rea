/** Closers of process-owned CLI resources, by owner name. */
export class CliResourceOwners {
  readonly #closers = new Map<string, () => Promise<void>>();

  /** Register an owner's closer; a repeated name keeps its first closer. */
  own(name: string, close: () => Promise<void>): void {
    if (!this.#closers.has(name)) this.#closers.set(name, close);
  }

  names(): readonly string[] {
    return [...this.#closers.keys()];
  }

  /** Settle every owner, then report each failure. */
  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#closers.values()].map((close) => close()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "CLI resource cleanup failed");
  }
}

/**
 * Process-owned CLI resources. Each owning module registers its closer when it
 * loads, so a CLI that loads only some command families closes exactly the
 * owners it loaded without importing the others.
 */
const processOwners = new CliResourceOwners();

export const ownCliProcessResource = (
  name: string,
  close: () => Promise<void>,
): void => processOwners.own(name, close);

/** Owners registered in this process, in registration order. */
export const cliProcessResourceOwners = (): readonly string[] =>
  processOwners.names();

/** Close every process-owned resource used by CLI commands. */
export const closeCliResources = (): Promise<void> => processOwners.close();
