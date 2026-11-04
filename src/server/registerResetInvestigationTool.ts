import { toolContract } from "../contracts/toolContracts.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";

/** The shared session owns admission, checkpoint publication and reset completion. */
export const registerResetInvestigationTool = ({
  server,
  session,
  artifactResources,
  closeProcessResources,
}: Pick<
  LifecycleToolRegistration,
  "server" | "session" | "artifactResources" | "closeProcessResources"
>): void => {
  const contract = toolContract("reset_investigation");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const result = await session.resetInvestigation({
        ...(input.save_path === undefined ? {} : { savePath: input.save_path }),
        overwrite: input.overwrite,
        signal: context.mcpReq.signal,
        retryCleanup: async () => {
          // Both adapter owners settle under the session's reset drain. Retry
          // keeps the shared artifact scope open for the next investigation.
          const [process, artifacts] = await Promise.all([
            closeProcessResources(),
            artifactResources.retryCleanup().then(
              () => ok(null),
              (cause: unknown) => {
                const observation = ArtifactReaderFailure.cleanupObservation(
                  cause,
                  "MCP artifact resources",
                );
                const error = new ProviderCleanupError(
                  "rea",
                  observation.resources,
                  { reason: observation.reason },
                  { cause, operation: contract.name },
                );
                bindArtifactFileCleanup(cause, error);
                return err(error);
              },
            ),
          ]);
          if (!process.ok && !artifacts.ok)
            return err(
              analysisErrorWithCleanupFailure(
                process.error,
                artifacts.error,
                contract.name,
              ).bindCleanupDependencies([process.error, artifacts.error]),
            );
          return process.ok ? artifacts : process;
        },
      });
      return server.delivery.toCallToolResult(result, contract);
    },
  );
};
