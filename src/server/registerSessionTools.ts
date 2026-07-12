import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BinarySession } from "../application/BinarySession.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";

/** Register MCP-only target lifecycle operations on a long-lived session. */
export const registerSessionTools = (
  server: McpServer,
  session: BinarySession,
  logger: Logger,
): void => {
  const [openContract, closeContract, statusContract] = SESSION_TOOL_CONTRACTS;
  server.registerTool(
    openContract.name,
    {
      description: openContract.description,
      inputSchema: openContract.inputSchema,
    },
    async (input, context) => {
      const parsed = z.object({ path: z.string().min(1) }).parse(input);
      const opened = await logToolExecution(logger, openContract.name, () =>
        session.open(parsed.path, { signal: context.mcpReq.signal }),
      );
      return opened.ok
        ? toCallToolResult({
            ok: true,
            value: {
              path: opened.value.path,
              format: opened.value.format,
              kind: opened.value.kind,
              loaderArgs: [...opened.value.loaderArgs],
            },
          })
        : toCallToolResult(opened);
    },
  );
  server.registerTool(
    closeContract.name,
    {
      description: closeContract.description,
      inputSchema: closeContract.inputSchema,
    },
    async () =>
      toCallToolResult(
        await logToolExecution(logger, closeContract.name, () =>
          session.close(),
        ),
      ),
  );
  server.registerTool(
    statusContract.name,
    {
      description: statusContract.description,
      inputSchema: statusContract.inputSchema,
    },
    () => toCallToolResult({ ok: true, value: session.status() }),
  );
};
