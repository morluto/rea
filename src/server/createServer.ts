import { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerSessionTools } from "./registerSessionTools.js";
import { silentLogger, type Logger } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";

/**
 * Construct one MCP server without acquiring subprocess resources.
 * Supplying a session adds target lifecycle tools; omitting it retains the
 * fixed-target seam used by focused tests and embedders.
 */
export const createServer = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
  logger: Logger = silentLogger,
  processPolicy?: ProcessExecutionPolicy,
): McpServer => {
  const server = new McpServer(
    { name: PRODUCT_IDENTITY.mcpServerKey, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        session === undefined
          ? "Reverse-engineering tools for an active analysis target. Start with binary_overview."
          : "Reverse-engineering tools for configured analysis providers. Open a target with open_binary, then start with binary_overview.",
    },
  );
  const toolLogger = logger.child({ layer: "server" });
  const activeTarget =
    session === undefined ? undefined : () => session.activeTarget();
  const provider = session?.providerIdentity();
  const recordEvidence =
    session === undefined
      ? undefined
      : (evidence: Parameters<typeof session.recordEvidence>[0]) =>
          session.recordEvidence(evidence);
  registerOfficialTools(
    server,
    analysis,
    toolLogger,
    activeTarget,
    provider,
    recordEvidence,
  );
  registerEnhancedTools(
    server,
    analysis,
    toolLogger,
    activeTarget,
    provider,
    recordEvidence,
  );
  if (session !== undefined)
    registerSessionTools(server, session, toolLogger, processPolicy);
  return server;
};
