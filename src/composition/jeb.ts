import type { JebAnalysisPort } from "../application/jeb/JebAnalysisPort.js";
import type { JebMcpConnectionFactory } from "../jeb/JebMcpConnection.js";
import { JebProvider } from "../jeb/JebProvider.js";

/** Construct one JEB provider bound to the caller-selected MCP endpoint. */
export const createJebAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  connectionFactory?: JebMcpConnectionFactory,
): JebAnalysisPort =>
  new JebProvider({
    environment,
    ...(connectionFactory === undefined ? {} : { connectionFactory }),
  });
