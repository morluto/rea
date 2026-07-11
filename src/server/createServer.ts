import { McpServer } from "@modelcontextprotocol/server";

import type { HopperToolPort } from "../application/HopperToolPort.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";

/** Construct one MCP server instance without acquiring subprocess resources. */
export const createServer = (hopper: HopperToolPort): McpServer => {
  const server = new McpServer(
    { name: "betterBinaryMCP", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Reverse-engineering tools for Hopper Disassembler. Start with binary_overview.",
    },
  );
  registerOfficialTools(server, hopper);
  registerEnhancedTools(server, hopper);
  return server;
};
