import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";

import { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import type { FridaInstrumentationPort } from "../ports/frida/FridaInstrumentationPort.js";
import { createFridaInstrumentationProvider } from "../composition/frida.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import {
  fridaDeviceSelection,
  fridaRemoteConnection,
  instrumentWithFrida,
} from "../application/frida/fridaContractRequests.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { FRIDA_TOOL_CONTRACTS } from "../contracts/fridaToolContracts.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Script sources stay optional in the options schema; exactly one is required. */
const exactlyOneScriptSource =
  "Provide exactly one of --script or --script-file.";

/** The CLI selects the local device when the caller selects none. */
const localUnlessSelected = <
  Input extends { readonly device_id?: unknown; readonly remote?: unknown },
>(
  input: Input,
): Input =>
  input.device_id === undefined && input.remote === undefined
    ? { ...input, device_id: "local" }
    : input;

/** Register Frida discovery and one-shot instrumentation CLI operations. */
export const registerFridaCommands = (
  cli: CliInstance,
  logger: Logger,
  provider: FridaInstrumentationPort = createFridaInstrumentationProvider(),
): void => {
  const service = new FridaInstrumentationService(provider);
  // CLI calls own a disposable provider; MCP retains its shared provider until
  // server shutdown. Await cleanup here, including failed startup resources.
  const cleanup = { close: () => provider.closeAll() };
  const instrumentContract = contractNamed(
    FRIDA_TOOL_CONTRACTS,
    "instrument_with_frida",
  );
  // Discovery commands take each remote member as its own option; any one
  // supplies the whole `remote` object, so the contract names a missing
  // address.
  const remoteMembers = {
    address: {
      name: "remoteAddress",
      description: "Remote Frida host address, optionally with a port",
    },
    token: { description: "Remote authentication token" },
    certificate: { description: "Remote TLS certificate" },
    origin: { description: "Remote connection origin" },
    keepalive_interval: { name: "keepaliveInterval" },
  };
  // Discovery admits the request MCP would send, then runs it.
  const discover =
    <Input, Value extends AnalysisPartialObservation>(
      contract: { readonly name: string; readonly inputSchema: z.ZodType },
      run: (input: Input) => Promise<Result<Value, AnalysisError>>,
      selected: (input: Input) => Input = (input) => input,
    ) =>
    (input: Input, { signal }: { readonly signal: AbortSignal }) =>
      finishAnalysisCommand(
        async () => {
          const candidate = selected(input);
          const admitted = contract.inputSchema.safeParse(candidate);
          return admitted.success
            ? run(admitted.data as Input)
            : err(
                analysisInputErrorFromIssues(
                  contract.name,
                  admitted.error.issues,
                  candidate,
                ),
              );
        },
        cleanup,
        "frida",
        contract.name,
        signal,
      ).then(projectCliAnalysisResult);
  const listDevices = contractNamed(FRIDA_TOOL_CONTRACTS, "list_frida_devices");
  const listProcesses = contractNamed(
    FRIDA_TOOL_CONTRACTS,
    "list_frida_processes",
  );
  registerContractCommand(
    cli,
    logger,
    listDevices,
    {
      description: "List local Frida devices and an optional remote endpoint",
      flatten: { remote: remoteMembers },
    },
    discover(listDevices, (input) =>
      service.listDevices(fridaRemoteConnection(input.remote)),
    ),
  );
  registerContractCommand(
    cli,
    logger,
    listProcesses,
    {
      description: "List processes visible through a Frida device",
      fields: { device_id: { description: "Frida device identifier" } },
      flatten: { remote: remoteMembers },
    },
    discover(
      listProcesses,
      (input) => service.listProcesses(fridaDeviceSelection(input)),
      localUnlessSelected,
    ),
  );
  // One target positional selects the PID or the program by mode, and the
  // script option given selects source_kind; the handler fills those
  // fields and the contract admits the request MCP would send.
  registerContractCommand(
    cli,
    logger,
    instrumentContract,
    {
      description: `Run one Frida script against a selected process and detach. ${exactlyOneScriptSource}`,
      positionals: ["mode"],
      cliOptions: {
        target: z
          .string()
          .min(1)
          .describe("Process ID for attach or program path for spawn"),
      },
      cliPositionals: ["target"],
      handlerFields: ["pid", "program", "source_kind"],
      // The CLI resolves a relative script file against the caller's
      // directory; the contract admits only absolute paths.
      callerPaths: ["path"],
      fields: {
        mode: { description: "Attach to a PID or spawn a program" },
        device_id: { description: "Frida device identifier" },
        source: {
          name: "script",
          description: `Inline JavaScript to load. ${exactlyOneScriptSource}`,
        },
        path: {
          name: "scriptFile",
          description: `Path to JavaScript source file. ${exactlyOneScriptSource}`,
        },
        argv: {
          name: "argument",
          description: "Arguments passed to a spawned target",
        },
        duration_ms: {
          description: "Instrumentation duration in milliseconds",
        },
      },
      flatten: {
        remote: remoteMembers,
        capture_limits: {
          session_bytes: {
            name: "captureSessionBytes",
            description:
              "Session retention bytes including encoded payloads; select before starting the experiment",
          },
          message_text_bytes: {
            name: "captureMessageTextBytes",
            description: "Retained bytes per Frida error text field",
          },
          message_type_bytes: {
            name: "captureMessageTypeBytes",
            description: "Retained bytes per Frida message type",
          },
          json_nodes: {
            name: "captureJsonNodes",
            description: "Retained JSON nodes per Frida payload",
          },
          json_depth: {
            name: "captureJsonDepth",
            description: "Retained JSON nesting depth per Frida payload",
          },
        },
      },
    },
    (input, { signal, cliOptions: { target } }) => {
      const refused = (
        path: string,
        message: string,
      ): Promise<ReturnType<typeof projectAnalysisError>> =>
        Promise.resolve(
          projectAnalysisError(
            new AnalysisInputError(instrumentContract.name, undefined, [
              { path: [path], reason: "invalid_value", message },
            ]),
          ),
        );
      if (input.mode === "attach" && input.argv !== undefined)
        return refused(
          "argv",
          "--argument is only valid in spawn mode; remove it when attaching to a process.",
        );
      if ((input.source === undefined) === (input.path === undefined))
        return refused("source", exactlyOneScriptSource);
      if (input.device_id !== undefined && input.remote !== undefined)
        return refused(
          "device_id",
          "Choose either --device-id or --remote-address, not both",
        );
      const pid =
        /^[0-9]+$/u.test(target) &&
        Number.isSafeInteger(Number(target)) &&
        Number(target) > 0
          ? Number(target)
          : undefined;
      if (input.mode === "attach" && pid === undefined)
        return refused(
          "target",
          "attach mode needs a positive integer process ID.",
        );
      const candidate = localUnlessSelected({
        ...input,
        ...(input.mode === "attach" ? { pid } : { program: target }),
        source_kind: input.path === undefined ? "inline" : "file",
      });
      // The contract admits the request MCP would send.
      const admitted = instrumentContract.inputSchema.safeParse(candidate);
      if (!admitted.success)
        return Promise.resolve(
          projectAnalysisError(
            analysisInputErrorFromIssues(
              instrumentContract.name,
              admitted.error.issues,
              candidate,
            ),
          ),
        );
      return finishAnalysisCommand(
        async () => {
          const result = await instrumentWithFrida(
            service,
            admitted.data,
            signal,
          );
          if (!result.ok) return result;
          if (result.value.cleanupError !== null) process.exitCode = 1;
          return ok(result.value.evidence);
        },
        cleanup,
        "frida",
        instrumentContract.name,
        signal,
      ).then(projectCliAnalysisResult);
    },
  );
};
