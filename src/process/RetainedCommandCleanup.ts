import { rm } from "node:fs/promises";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import { processInspectionCleanupFailures } from "./ProcessInspectionCleanup.js";
import { OwnedCommandFailure } from "./OwnedCommand.js";

/** Exact command and scratch-folder ownership across partial cleanup retries. */
export class RetainedCommandCleanup {
  readonly #owner;
  readonly #preparation;
  readonly #processResources: readonly string[];
  #stopped: boolean;
  readonly #prepared = new Set<object>();
  #folderPresent = true;

  constructor(
    readonly folder: string,
    cause: unknown,
  ) {
    this.#owner =
      cause instanceof OwnedCommandFailure ? cause.cleanupOwner : undefined;
    this.#preparation = processInspectionCleanupFailures(
      cause instanceof OwnedCommandFailure ? cause.preparationFailure : cause,
    );
    this.#processResources =
      cause instanceof OwnedCommandFailure ? cause.resources : [];
    this.#stopped = this.#owner === undefined;
  }

  get hasPendingCommandResources(): boolean {
    return (
      !this.#stopped ||
      this.#preparation.some((failure) => !this.#prepared.has(failure))
    );
  }

  get cleanupResources(): readonly string[] {
    return [
      ...new Set([
        ...(!this.#stopped ? this.#processResources : []),
        ...this.#preparation.flatMap((failure) =>
          this.#prepared.has(failure)
            ? []
            : failure instanceof DarwinProcessOwnershipInspectionError
              ? (failure.cleanupFailure?.cleanupResources ?? [])
              : [failure.path],
        ),
        ...(this.#folderPresent ? [this.folder] : []),
      ]),
    ];
  }

  async close(): Promise<void> {
    if (!this.#stopped && this.#owner !== undefined) {
      const result = await this.#owner.stop();
      if (result.status === "incomplete") throw new Error(result.reason);
      this.#owner.dispose();
      this.#stopped = true;
    }
    const failures: unknown[] = [];
    for (const failure of this.#preparation) {
      if (this.#prepared.has(failure)) continue;
      try {
        if (failure instanceof DarwinProcessOwnershipInspectionError) {
          if (failure.cleanupOwner === undefined) throw failure;
          await failure.cleanupOwner.close();
        } else await failure.owner.close();
        this.#prepared.add(failure);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Command inspection cleanup remains incomplete",
      );
    if (this.#folderPresent) {
      await rm(this.folder, { recursive: true, force: true });
      this.#folderPresent = false;
    }
  }
}
