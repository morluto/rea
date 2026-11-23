import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ForwardedResult } from "../application/desktop/DesktopBuildComputers.js";
import { DesktopBuildSteps } from "../application/desktop/DesktopBuildSteps.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";
import type { ContractToolBindings } from "./contractToolBindings.js";
import {
  ForwardedValue,
  type ValueOutcome,
  type ValueToolRequest,
} from "./contractToolHandler.js";
import {
  redactedResult,
  withHeartbeat,
  type DesktopBuildToolComputers,
} from "./desktopBuildDelivery.js";

/** The tools that drive build computers. */
type DesktopBuildTool =
  | "start_build_computer"
  | "act_on_build_computer"
  | "start_build_capture"
  | "mark_build_checkpoint"
  | "stop_build_capture"
  | "export_build_environment"
  | "check_build_task"
  | "measure_build_task"
  | "record_build_consent"
  | "close_build_computer";

/**
 * Bind desktop build computer tools with secret redaction and progress
 * heartbeats so long-running steps keep MCP client timeouts alive without
 * leaking typed secrets in responses or refusals.
 */
export const bindDesktopBuildTools = (
  computers: DesktopBuildToolComputers,
): ContractToolBindings => {
  const steps = new DesktopBuildSteps(computers);
  const presentResult = (result: CallToolResult) =>
    redactedResult(result, computers.redaction);
  const tool = <Schema extends z.ZodType>(
    contract: { readonly name: string; readonly inputSchema: Schema },
    run: (
      input: z.output<Schema>,
      request: ValueToolRequest,
    ) => Promise<ValueOutcome>,
  ) => ({
    admission: "application" as const,
    presentResult,
    value: async (raw: unknown, request: ValueToolRequest) => {
      const parsed = z.safeParse(contract.inputSchema, raw);
      return parsed.success
        ? run(parsed.data, request)
        : err(
            analysisInputErrorFromIssues(
              contract.name,
              parsed.error.issues,
              raw,
              { cause: parsed.error },
            ),
          );
    },
  });
  const heartbeat = <Value>(
    { progress }: ValueToolRequest,
    phase: DesktopBuildTool,
    run: (progress: ProgressReporter) => Promise<Value>,
  ) => withHeartbeat(progress, phase, computers.progressMs, run);
  // A forwarded driver answer, such as a screenshot, follows REA's JSON.
  const forwarded = (
    result: Result<ForwardedResult<JsonValue>, AnalysisError>,
  ): ValueOutcome =>
    result.ok
      ? ok(new ForwardedValue(result.value.value, result.value.content))
      : result;
  return {
    start_build_computer: tool(
      toolContract("start_build_computer"),
      async (input, { signal, progress }) =>
        forwarded(await computers.start(input, signal, progress)),
    ),
    // An action can wait for the call before it on its computer, and a
    // reset for the relaunched app, which can take minutes.
    act_on_build_computer: tool(
      toolContract("act_on_build_computer"),
      async (input, request) =>
        forwarded(
          await heartbeat(request, "act_on_build_computer", () =>
            computers.act(input, request.signal),
          ),
        ),
    ),
    start_build_capture: tool(
      toolContract("start_build_capture"),
      async (input, request) =>
        forwarded(
          await heartbeat(request, "start_build_capture", () =>
            steps.startCapture(input, request.signal),
          ),
        ),
    ),
    mark_build_checkpoint: tool(
      toolContract("mark_build_checkpoint"),
      (input, request) =>
        heartbeat(request, "mark_build_checkpoint", () =>
          steps.markCheckpoint(input, request.signal),
        ),
    ),
    stop_build_capture: tool(
      toolContract("stop_build_capture"),
      (input, request) =>
        heartbeat(request, "stop_build_capture", () =>
          steps.stopCapture(input, request.signal),
        ),
    ),
    export_build_environment: tool(
      toolContract("export_build_environment"),
      (input, request) =>
        heartbeat(request, "export_build_environment", () =>
          steps.exportEnvironment(input, request.signal),
        ),
    ),
    check_build_task: tool(toolContract("check_build_task"), (input, request) =>
      heartbeat(request, "check_build_task", (progress) =>
        steps.checkTask(input, request.signal, progress),
      ),
    ),
    // Solves run one at a time for minutes each, so progress keeps the
    // client waiting.
    measure_build_task: tool(
      toolContract("measure_build_task"),
      (input, request) =>
        heartbeat(request, "measure_build_task", (progress) =>
          computers.measure(input, request.signal, progress),
        ),
    ),
    record_build_consent: tool(
      toolContract("record_build_consent"),
      (input, { signal }) => steps.recordConsent(input, signal),
    ),
    close_build_computer: tool(toolContract("close_build_computer"), (input) =>
      computers.close(input.computer_id),
    ),
  };
};
