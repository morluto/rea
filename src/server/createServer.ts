import { McpServer } from "@modelcontextprotocol/server";

import type { HopperToolPort } from "../application/HopperToolPort.js";
import type { BinarySession } from "../application/BinarySession.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerSessionTools } from "./registerSessionTools.js";

/**
 * Construct one MCP server without acquiring subprocess resources.
 * Supplying a session adds target lifecycle tools; omitting it retains the
 * fixed-target seam used by focused tests and embedders.
 */
export const createServer = (
  hopper: HopperToolPort,
  session?: BinarySession,
): McpServer => {
  const server = new McpServer(
    { name: PRODUCT_IDENTITY.mcpServerKey, version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        session === undefined
          ? "Reverse-engineering tools for an active Hopper Disassembler target. Start with binary_overview."
          : "Reverse-engineering tools for Hopper Disassembler. Open a target with open_binary, then start with binary_overview.",
    },
  );
  registerOfficialTools(server, hopper);
  registerEnhancedTools(server, hopper);
  if (session !== undefined) registerSessionTools(server, session);
  return server;
};
