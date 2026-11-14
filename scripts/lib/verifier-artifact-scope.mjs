import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";

/** A failed close retains the scope that can retry all of its owners. */
export class VerifierArtifactCleanupFailure extends AggregateError {
  constructor(scope, failures, cause) {
    super(failures, "Verifier cleanup failed", { cause });
    this._tag = "VerifierArtifactCleanupFailure";
    this.cleanupOwner = scope;
  }
}

/** Run one verifier operation and retain its exact scope if close fails. */
export async function withVerifierArtifactScope(operation) {
  const scope = new ArtifactResourceScope();
  let outcome;
  try {
    outcome = { ok: true, value: await operation(scope) };
  } catch (cause) {
    outcome = { ok: false, cause };
  }
  try {
    await scope.close();
  } catch (cleanupCause) {
    throw new VerifierArtifactCleanupFailure(
      scope,
      outcome.ok ? [cleanupCause] : [outcome.cause, cleanupCause],
      outcome.ok ? cleanupCause : outcome.cause,
    );
  }
  if (!outcome.ok) throw outcome.cause;
  return outcome.value;
}
