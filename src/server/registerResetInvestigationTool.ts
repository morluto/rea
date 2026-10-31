import { toolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { LifecycleToolRegistration } from "./registerSessionTools.js";

/** The shared session owns admission, checkpoint publication and reset completion. */
export const registerResetInvestigationTool = ({
  server,
  session,
  closeProcessResources,
}: Pick<
  LifecycleToolRegistration,
  "server" | "session" | "closeProcessResources"
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
        retryCleanup: closeProcessResources,
      });
      return server.delivery.toCallToolResult(result, contract);
    },
  );
};
