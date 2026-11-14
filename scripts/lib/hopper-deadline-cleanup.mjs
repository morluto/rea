import { rm } from "node:fs/promises";

export class HopperDeadlineCleanupFailure extends AggregateError {
  constructor(owner, failures) {
    super(
      failures,
      `Hopper cleanup incomplete; workspace may remain at ${owner.workspace}`,
    );
    this._tag = "HopperDeadlineCleanupFailure";
    this.cleanupOwner = owner;
  }
}

/** Own the client, profile scope, and workspace until all cleanup completes. */
export class HopperDeadlineCleanup {
  #client;
  #profile;
  #pending;
  #removed = false;

  constructor(workspace, profile) {
    this.workspace = workspace;
    this.#profile = profile;
  }

  setClient(client) {
    this.#client = client;
  }

  close() {
    if (this.#pending !== undefined) return this.#pending;
    const attempt = this.#close();
    const pending = attempt.finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  async #close() {
    if (this.#removed) return;
    const failures = [];
    if (this.#client !== undefined) {
      try {
        const result = await this.#client.close();
        if (!result.ok) throw result.error;
        this.#client = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (this.#profile !== undefined) {
      try {
        await this.#profile.close();
        this.#profile = undefined;
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length === 0) {
      try {
        await rm(this.workspace, { recursive: true, force: true });
        this.#removed = true;
        return;
      } catch (cause) {
        failures.push(cause);
      }
    }
    throw new HopperDeadlineCleanupFailure(this, failures);
  }
}
