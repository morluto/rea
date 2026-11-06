import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  DesktopBuildComputers,
  ForwardedResult,
} from "../application/desktop/DesktopBuildComputers.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { logToolExecution } from "./toolLogging.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Parse a tool's own input so a refusal names the field. */
const admit = <Schema extends z.ZodType>(
  contract: { readonly name: string; readonly inputSchema: Schema },
  raw: unknown,
): Result<z.output<Schema>, AnalysisError> => {
  const parsed = z.safeParse(contract.inputSchema, raw);
  return parsed.success
    ? ok(parsed.data)
    : err(
        analysisInputErrorFromIssues(contract.name, parsed.error.issues, raw, {
          cause: parsed.error,
        }),
      );
};

/** Register the build computer session tools on the REA MCP server. */
export const registerDesktopBuildTools = (
  server: EvidenceMcpServer,
  computers: Pick<DesktopBuildComputers, "start" | "act" | "close">,
  logger: Logger,
): void => {
  const forward = (
    contract: ToolContract,
    result: Result<ForwardedResult<JsonValue>, AnalysisError>,
  ): CallToolResult =>
    result.ok
      ? server.delivery.toForwardedToolResult(
          ok(result.value.value),
          contract,
          result.value.content,
        )
      : server.delivery.toCallToolResult(result, contract);
  const start = toolContract("start_build_computer");
  server.registerTool(
    start.name,
    applicationToolRegistrationOptions(start),
    async (raw: unknown, context: ServerContext) => {
      const input = admit(start, raw);
      if (!input.ok) return server.delivery.toCallToolResult(input, start);
      return forward(
        start,
        await logToolExecution(logger, start.name, () =>
          computers.start(input.value, context.mcpReq.signal),
        ),
      );
    },
  );
  const act = toolContract("act_on_build_computer");
  server.registerTool(
    act.name,
    applicationToolRegistrationOptions(act),
    async (raw: unknown, context: ServerContext) => {
      const input = admit(act, raw);
      if (!input.ok) return server.delivery.toCallToolResult(input, act);
      return forward(
        act,
        await logToolExecution(logger, act.name, () =>
          computers.act(input.value, context.mcpReq.signal),
        ),
      );
    },
  );
  const close = toolContract("close_build_computer");
  server.registerTool(
    close.name,
    applicationToolRegistrationOptions(close),
    async (raw: unknown) => {
      const input = admit(close, raw);
      if (!input.ok) return server.delivery.toCallToolResult(input, close);
      return server.delivery.toCallToolResult(
        await logToolExecution(logger, close.name, () =>
          computers.close(input.value.computer_id),
        ),
        close,
      );
    },
  );
};
