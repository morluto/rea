import { rm } from "node:fs/promises";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "./OwnedCommand.js";

/** Exact command and scratch-folder ownership across partial cleanup retries. */
export class RetainedCommandCleanup {
  readonly #owner;
  readonly #preparation;
  readonly #processResources: readonly string[];
  #stopped: boolean;
  #prepared: boolean;
  #folderPresent = true;

  constructor(
    readonly folder: string,
    cause: unknown,
  ) {
    this.#owner =
      cause instanceof OwnedCommandFailure ? cause.cleanupOwner : undefined;
    this.#preparation =
      cause instanceof OwnedCommandFailure
        ? cause.preparationFailure
        : cause instanceof DarwinProcessOwnershipInspectionError
          ? cause
          : undefined;
    this.#processResources =
      cause instanceof OwnedCommandFailure ? cause.resources : [];
    this.#stopped = this.#owner === undefined;
    this.#prepared = this.#preparation?.cleanupOwner === undefined;
  }

  get hasProcess(): boolean {
    return !this.#stopped || !this.#prepared;
  }

  get cleanupResources(): readonly string[] {
    return [
      ...new Set([
        ...(!this.#stopped ? this.#processResources : []),
        ...(!this.#prepared
          ? (this.#preparation?.cleanupFailure?.cleanupResources ?? [])
          : []),
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
    if (!this.#prepared) {
      await this.#preparation?.cleanupOwner?.close();
      this.#prepared = true;
    }
    if (this.#folderPresent) {
      await rm(this.folder, { recursive: true, force: true });
      this.#folderPresent = false;
    }
  }
}
