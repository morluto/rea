import { rm } from "node:fs/promises";

/**
 * Release the evaluation commands, then remove the run root, or keep it when
 * asked; the root stays while the commands are unconfirmed. Copied
 * authentication is removed independently, even when the commands or the root
 * fail to release.
 *
 * A failure is one AggregateError: the retained fixture's own failures, then
 * the authentication removal failure. A retained fixture stays its lease.
 */
export async function closeAgentEvaluation({
  fixture,
  commands,
  authPath,
  keepFixtures,
}) {
  fixture.releaseAfter(() => commands.close());
  const failures = [];
  const cleanupLeases = [];
  try {
    await (keepFixtures
      ? fixture.keep("REA_AGENT_EVAL_KEEP_FIXTURES=true")
      : fixture.release());
  } catch (cause) {
    // The fixture reports its retained cleanups as one AggregateError with
    // itself as the lease; join those failures rather than nesting them.
    if (cause instanceof AggregateError && cause.cleanupLeases !== undefined) {
      failures.push(...cause.errors);
      cleanupLeases.push(...cause.cleanupLeases);
    } else failures.push(cause);
  }
  try {
    await rm(authPath, { force: true });
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0)
    throw Object.assign(
      new AggregateError(failures, "Verifier cleanup failed"),
      cleanupLeases.length > 0 ? { cleanupLeases } : {},
    );
}
