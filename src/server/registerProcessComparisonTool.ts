import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { compareProcessEvidence } from "../application/process/ProcessComparisonService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { deliverInvestigationWorkflow } from "./deliverInvestigationWorkflow.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Adapt the shared process comparison workflow to the scoped MCP session. */
export const registerProcessComparisonTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_process_captures">>,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const result = compareProcessEvidence(
                input,
                session.evidenceForAnalysis.bind(session),
                { signal: context.mcpReq.signal },
              );
              if (!result.ok) throw result.error;
              return result.value;
            },
            (value) => value,
          );
          return deliverInvestigationWorkflow(
            server,
            session,
            contract,
            computed,
          );
        },
      ),
  );
};
