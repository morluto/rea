import type { FridaCapturePolicy } from "../domain/fridaCapturePolicy.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import type { FridaInstrumentationPort } from "../ports/frida/FridaInstrumentationPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  fridaDeviceSelection,
  fridaRemoteConnection,
  fridaScriptSource,
  fridaSessionStart,
  instrumentWithFrida,
} from "../application/frida/fridaContractRequests.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";

/** Register Frida device discovery and persistent instrumentation operations. */
export const registerFridaTools = (
  server: McpServer,
  provider: FridaInstrumentationPort,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  evidenceById?: EvidenceLookup,
): void => {
  const service = new FridaInstrumentationService(provider);
  const listDevices = toolContract("list_frida_devices");
  const listProcesses = toolContract("list_frida_processes");
  const start = toolContract("start_frida_session");
  const load = toolContract("load_frida_script");
  const resume = toolContract("resume_frida_session");
  const unload = toolContract("unload_frida_script");
  const status = toolContract("frida_session_status");
  const close = toolContract("close_frida_session");
  const instrument = toolContract("instrument_with_frida");

  server.registerTool(
    listDevices.name,
    toolRegistrationOptions(listDevices),
    async (input) => {
      const result = await logToolExecution(logger, listDevices.name, () =>
        service.listDevices(fridaRemoteConnection(input.remote)),
      );
      return delivery.toCallToolResult(result, listDevices);
    },
  );
  server.registerTool(
    listProcesses.name,
    toolRegistrationOptions(listProcesses),
    async (input) => {
      const result = await logToolExecution(logger, listProcesses.name, () =>
        service.listProcesses(fridaDeviceSelection(input)),
      );
      return delivery.toCallToolResult(result, listProcesses);
    },
  );
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) => {
      const session = fridaSessionStart(input);
      const result = await logToolExecution(logger, start.name, () =>
        session === undefined
          ? Promise.resolve({
              ok: false as const,
              error: new AnalysisInputError(start.name),
            })
          : service.startSession(session, context.mcpReq.signal),
      );
      if (!result.ok)
        return delivery.toPartialErrorToolResult(
          result.error,
          start.returnsTargetContent,
          recordEvidence,
        );
      return delivery.toCallToolResult(
        {
          ok: true,
          value: jsonValueSchema.parse(sessionOutput(result.value)),
        },
        start,
      );
    },
  );
  server.registerTool(
    load.name,
    toolRegistrationOptions(load),
    async (input, context: ServerContext) => {
      const source = fridaScriptSource(input);
      const result = await logToolExecution(logger, load.name, () =>
        source === undefined
          ? Promise.resolve({
              ok: false as const,
              error: new AnalysisInputError(load.name),
            })
          : service.loadScript(input.session_id, source, context.mcpReq.signal),
      );
      if (!result.ok)
        return delivery.toPartialErrorToolResult(
          result.error,
          load.returnsTargetContent,
          recordEvidence,
        );
      return delivery.toEvidenceToolResult(
        result.value,
        load,
        recordEvidence?.(result.value),
      );
    },
  );
  server.registerTool(
    resume.name,
    toolRegistrationOptions(resume),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, resume.name, () =>
        service.resumeSession(input.session_id, context.mcpReq.signal),
      );
      return result.ok
        ? delivery.toCallToolResult(
            { ok: true, value: { state: "running" } },
            resume,
          )
        : delivery.toCallToolResult(result, resume);
    },
  );
  server.registerTool(
    unload.name,
    toolRegistrationOptions(unload),
    async (input, context: ServerContext) => {
      const result = await logToolExecution(logger, unload.name, () =>
        service.unloadScript(
          input.session_id,
          input.script_id,
          context.mcpReq.signal,
        ),
      );
      return result.ok
        ? delivery.toCallToolResult(
            { ok: true, value: { unloaded: true } },
            unload,
          )
        : delivery.toCallToolResult(result, unload);
    },
  );
  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) => {
      const result = service.inspectStatus(input, {
        recordEvidence,
        evidenceById,
      });
      if (!result.ok) return delivery.toCallToolResult(result, status);
      return delivery.toEvidenceToolResult(
        result.value,
        status,
        recordEvidence?.(result.value),
      );
    },
  );
  server.registerTool(
    close.name,
    toolRegistrationOptions(close),
    async (input) => {
      const result = await logToolExecution(logger, close.name, () =>
        service.closeSession(input.session_id),
      );
      return result.ok
        ? delivery.toCallToolResult(
            { ok: true, value: { target_state: "unknown" } },
            close,
          )
        : delivery.toCallToolResult(result, close);
    },
  );
  server.registerTool(
    instrument.name,
    toolRegistrationOptions(instrument),
    async (input, context: ServerContext) => {
      const operation = instrumentWithFrida(
        service,
        input,
        context.mcpReq.signal,
      );
      const result = await logToolExecution(
        logger,
        instrument.name,
        () => operation,
      );
      if (!result.ok)
        return delivery.toPartialErrorToolResult(
          result.error,
          instrument.returnsTargetContent,
          recordEvidence,
        );
      return delivery.toEvidenceToolResult(
        result.value.evidence,
        instrument,
        recordEvidence?.(result.value.evidence),
      );
    },
  );
};

const sessionOutput = (session: {
  readonly captureLimits?: FridaCapturePolicy;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly target: string;
  readonly pid: number;
  readonly mode: "attach" | "spawn";
  readonly state: "paused" | "running" | "detached";
}) => ({
  session_id: session.sessionId,
  ...(session.captureLimits === undefined
    ? {}
    : { capture_limits: session.captureLimits }),
  device_id: session.deviceId,
  target: session.target,
  pid: session.pid,
  mode: session.mode,
  state: session.state,
});
