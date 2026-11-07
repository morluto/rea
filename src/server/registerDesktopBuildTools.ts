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
import { DesktopBuildSteps } from "../application/desktop/DesktopBuildSteps.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { mcpProgressReporter } from "./mcpProgress.js";
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

const HEARTBEAT_MS = 5_000;

/** Report progress every few seconds while a long build step works, so a client's request timeout can reset. */
const withHeartbeat = async <Value>(
  context: ServerContext,
  phase: string,
  run: () => Promise<Value>,
): Promise<Value> => {
  const progress = mcpProgressReporter(context);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void progress
      .report({
        phase,
        completed: 0,
        total: null,
        message: `working (${String(Math.round((Date.now() - startedAt) / 1000))} s)`,
      })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
};

/** Registration of one build tool: the server, its logger and the tool's contract. */
interface Registration<Schema extends z.ZodType> {
  readonly server: EvidenceMcpServer;
  readonly logger: Logger;
  readonly contract: ToolContract & {
    readonly name: string;
    readonly inputSchema: Schema;
  };
}

/** Register a tool whose result carries a forwarded driver answer, such as a screenshot, after REA's JSON. */
const registerForwarded = <Schema extends z.ZodType>(
  { server, logger, contract }: Registration<Schema>,
  run: (
    input: z.output<Schema>,
    context: ServerContext,
  ) => Promise<Result<ForwardedResult<JsonValue>, AnalysisError>>,
): void => {
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    async (raw: unknown, context: ServerContext): Promise<CallToolResult> => {
      const input = admit(contract, raw);
      if (!input.ok) return server.delivery.toCallToolResult(input, contract);
      const result = await logToolExecution(logger, contract.name, () =>
        run(input.value, context),
      );
      return result.ok
        ? server.delivery.toForwardedToolResult(
            ok(result.value.value),
            contract,
            result.value.content,
          )
        : server.delivery.toCallToolResult(result, contract);
    },
  );
};

/** Register a tool with a plain JSON result. */
const registerPlain = <Schema extends z.ZodType>(
  { server, logger, contract }: Registration<Schema>,
  run: (
    input: z.output<Schema>,
    context: ServerContext,
  ) => Promise<Result<JsonValue, AnalysisError>>,
): void => {
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    async (raw: unknown, context: ServerContext): Promise<CallToolResult> => {
      const input = admit(contract, raw);
      if (!input.ok) return server.delivery.toCallToolResult(input, contract);
      return server.delivery.toCallToolResult(
        await logToolExecution(logger, contract.name, () =>
          run(input.value, context),
        ),
        contract,
      );
    },
  );
};

/** Register the build computer session tools and the build steps on them on the REA MCP server. */
export const registerDesktopBuildTools = (
  server: EvidenceMcpServer,
  computers: Pick<DesktopBuildComputers, "start" | "act" | "close" | "steps">,
  logger: Logger,
): void => {
  const tool = <Name extends Parameters<typeof toolContract>[0]>(
    name: Name,
  ) => ({
    server,
    logger,
    contract: toolContract(name),
  });
  const steps = new DesktopBuildSteps(computers);
  registerForwarded(tool("start_build_computer"), (input, context) =>
    computers.start(input, context.mcpReq.signal, mcpProgressReporter(context)),
  );
  // An action can wait for the call before it on its computer, and a reset for the relaunched app, which can take minutes.
  registerForwarded(tool("act_on_build_computer"), (input, context) =>
    withHeartbeat(context, "act_on_build_computer", () =>
      computers.act(input, context.mcpReq.signal),
    ),
  );
  registerForwarded(tool("start_build_capture"), (input, context) =>
    withHeartbeat(context, "start_build_capture", () =>
      steps.startCapture(input, context.mcpReq.signal),
    ),
  );
  registerPlain(tool("mark_build_checkpoint"), (input, context) =>
    withHeartbeat(context, "mark_build_checkpoint", () =>
      steps.markCheckpoint(input, context.mcpReq.signal),
    ),
  );
  registerPlain(tool("stop_build_capture"), (input, context) =>
    withHeartbeat(context, "stop_build_capture", () =>
      steps.stopCapture(input, context.mcpReq.signal),
    ),
  );
  registerPlain(tool("export_build_environment"), (input, context) =>
    withHeartbeat(context, "export_build_environment", () =>
      steps.exportEnvironment(input, context.mcpReq.signal),
    ),
  );
  registerPlain(tool("check_build_task"), (input, context) =>
    withHeartbeat(context, "check_build_task", () =>
      steps.checkTask(input, context.mcpReq.signal),
    ),
  );
  registerPlain(tool("close_build_computer"), (input) =>
    computers.close(input.computer_id),
  );
};
