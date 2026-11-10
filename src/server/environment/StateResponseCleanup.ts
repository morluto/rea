import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../../artifacts/ArtifactResourceScope.js";

/** Retain a cancelled response branch until its underlying cancellation settles. */
export class StateResponseCleanup {
  readonly #scope = new ArtifactResourceScope();

  constructor(private readonly changed: () => void = () => {}) {}

  get cleanupResources(): readonly string[] {
    return this.#scope.cleanupResources;
  }

  cancel(cancel: () => Promise<void>): void {
    let state:
      | { status: "pending" }
      | { status: "done" }
      | { status: "failed"; cause: unknown } = { status: "pending" };
    const owner: ArtifactResourceOwner = {
      kind: "lease",
      resource: "state response body",
      lease: {
        release: async () => {
          if (state.status === "pending")
            throw new Error("State response cancellation is still pending");
          if (state.status === "failed") throw state.cause;
        },
      },
    };
    this.#scope.retain(owner);
    this.changed();
    void Promise.resolve()
      .then(cancel)
      .then(
        async () => {
          state = { status: "done" };
          await this.#scope.release(owner);
          this.changed();
        },
        (cause: unknown) => {
          state = { status: "failed", cause };
          this.changed();
        },
      )
      .catch(() => undefined);
  }

  close(): Promise<void> {
    return this.#scope.close();
  }
}
