import { rm } from "node:fs/promises";

import { closeVerifierResources } from "./verifier-cleanup.mjs";

/**
 * Release the evaluation commands, then remove the run root, or keep it when
 * asked; the root stays while the commands are unconfirmed. Copied
 * authentication is removed independently, even when the commands or the root
 * fail to release.
 */
export async function closeAgentEvaluation({
  fixture,
  commands,
  authPath,
  keepFixtures,
}) {
  fixture.releaseAfter(() => commands.close());
  await closeVerifierResources([
    () =>
      keepFixtures
        ? fixture.keep("REA_AGENT_EVAL_KEEP_FIXTURES=true")
        : fixture.release(),
    () => rm(authPath, { force: true }),
  ]);
}
