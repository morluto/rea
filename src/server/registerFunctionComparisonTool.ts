import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { compareFunctionEvidence } from "../application/investigation/FunctionComparisonEvidence.js";
import { toolContract } from "../contracts/toolContracts.js";
import { deliverInvestigationWorkflow } from "./deliverInvestigationWorkflow.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/** Adapt the shared function-comparison workflow to the scoped MCP session. */
export const registerFunctionComparisonTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"compare_functions">>,
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
              const result = compareFunctionEvidence(
                input,
                session.evidenceForAnalysis.bind(session),
                context.mcpReq.signal,
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
