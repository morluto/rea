import type {
  ServerContext,
  CallToolResult,
} from "@modelcontextprotocol/server";

import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Run one complete tool workflow inside session admission when supplied. */
export const runAdmittedToolOperation = async (
  server: EvidenceMcpServer,
  admission: WithAdmittedAnalysis | undefined,
  operationName: string,
  signal: ServerContext["mcpReq"]["signal"],
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> => {
  if (admission === undefined) return operation();
  const admitted = await admission(operationName, signal, operation);
  return admitted.ok
    ? admitted.value
    : server.delivery.toErrorToolResult(admitted.error);
};
