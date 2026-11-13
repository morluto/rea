import { rm } from "node:fs/promises";

import { closeVerifierResources } from "./verifier-cleanup.mjs";

/** Remove copied authentication independently; retain ordinary files until commands release. */
export async function closeAgentEvaluation({
  commands,
  authPath,
  evaluationRoot,
  keepFixtures,
}) {
  let commandsReleased = false;
  await closeVerifierResources([
    async () => {
      await commands.close();
      commandsReleased = true;
    },
    () => rm(authPath, { force: true }),
    async () => {
      if (commandsReleased && !keepFixtures)
        await rm(evaluationRoot, { recursive: true, force: true });
    },
  ]);
}
