import type { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";

export class HopperDeadlineCleanupFailure extends AggregateError {
  readonly _tag: "HopperDeadlineCleanupFailure";
  readonly cleanupOwner: HopperDeadlineCleanup;
  constructor(owner: HopperDeadlineCleanup, failures: unknown[]);
}

export class HopperDeadlineCleanup {
  readonly workspace: string;
  constructor(workspace: string, profile: ArtifactResourceScope);
  setClient(client: {
    close(): Promise<{ ok: true } | { ok: false; error: unknown }>;
  }): void;
  close(): Promise<void>;
}
