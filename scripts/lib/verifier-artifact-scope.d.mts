import type { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";

export class VerifierArtifactCleanupFailure extends AggregateError {
  readonly _tag: "VerifierArtifactCleanupFailure";
  readonly cleanupOwner: ArtifactResourceScope;
  constructor(
    scope: ArtifactResourceScope,
    failures: unknown[],
    cause: unknown,
  );
}

export function withVerifierArtifactScope<T>(
  operation: (scope: ArtifactResourceScope) => Promise<T>,
): Promise<T>;
