import { fridaCapturePolicyInputSchema } from "../domain/fridaCapturePolicy.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";

import { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import type { FridaInstrumentationPort } from "../application/frida/FridaInstrumentationPort.js";
import { createFridaInstrumentationProvider } from "../composition/frida.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
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
import {
  FRIDA_KEEPALIVE_INTERVAL_DESCRIPTION,
  FRIDA_TOOL_CONTRACTS,
} from "../contracts/fridaToolContracts.js";
import { isValidFridaRemoteAddress } from "../domain/fridaRemoteAddress.js";
import type { Logger } from "pino";
import { cliDecimalField } from "./options.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
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
  const remoteOptions = z.object({
    remoteAddress: z
      .string()
      .min(1)
      .max(2048)
      .refine(isValidFridaRemoteAddress)
      .optional()
      .describe("Remote Frida host address, optionally with a port"),
    token: z.string().min(1).optional().describe("Remote authentication token"),
    certificate: z
      .string()
      .min(1)
      .optional()
      .describe("Remote TLS certificate"),
    origin: z.string().min(1).optional().describe("Remote connection origin"),
    keepaliveInterval: cliDecimalField(
      z
        .number()
        .int()
        .positive()
        .optional()
        .describe(FRIDA_KEEPALIVE_INTERVAL_DESCRIPTION),
    ),
  });
  const remoteAddressRequired = (
    options: z.infer<typeof remoteOptions>,
  ): boolean =>
    options.remoteAddress !== undefined ||
    (options.token === undefined &&
      options.certificate === undefined &&
      options.origin === undefined &&
      options.keepaliveInterval === undefined);

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
      command: CLI_COMMANDS.listFridaDevices,
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
      command: CLI_COMMANDS.listFridaProcesses,
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
  cli.command(CLI_COMMANDS.instrumentWithFrida, {
    description: `Run one Frida script against a selected process and detach. ${exactlyOneScriptSource}`,
    args: z.object({
      mode: z
        .enum(["attach", "spawn"])
        .describe("Attach to a PID or spawn a program"),
      target: z
        .string()
        .min(1)
        .describe("Process ID for attach or program path for spawn"),
    }),
    options: remoteOptions
      .extend({
        deviceId: z
          .string()
          .min(1)
          .optional()
          .describe("Frida device identifier"),
        script: z
          .string()
          .optional()
          .describe(`Inline JavaScript to load. ${exactlyOneScriptSource}`),
        scriptFile: localPathStringSchema
          .optional()
          .describe(
            `Path to JavaScript source file. ${exactlyOneScriptSource}`,
          ),
        argument: z
          .array(z.string())
          .optional()
          .describe("Arguments passed to a spawned target"),
        captureSessionBytes: cliDecimalField(
          fridaCapturePolicyInputSchema.shape.session_bytes,
        ).describe(
          "Session retention bytes including encoded payloads; select before starting the experiment",
        ),
        captureMessageTextBytes: cliDecimalField(
          fridaCapturePolicyInputSchema.shape.message_text_bytes,
        ).describe("Retained bytes per Frida error text field"),
        captureMessageTypeBytes: cliDecimalField(
          fridaCapturePolicyInputSchema.shape.message_type_bytes,
        ).describe("Retained bytes per Frida message type"),
        captureJsonNodes: cliDecimalField(
          fridaCapturePolicyInputSchema.shape.json_nodes,
        ).describe("Retained JSON nodes per Frida payload"),
        captureJsonDepth: cliDecimalField(
          fridaCapturePolicyInputSchema.shape.json_depth,
        ).describe("Retained JSON nesting depth per Frida payload"),
        durationMs: cliDecimalField(
          z
            .number()
            .int()
            .min(0)
            .max(60_000)
            .default(1_000)
            .describe("Instrumentation duration in milliseconds"),
        ),
      })
      .refine(
        (options) =>
          options.remoteAddress === undefined || options.deviceId === undefined,
        "Choose either deviceId or remoteAddress, not both",
      )
      .refine(
        remoteAddressRequired,
        "Remote credentials and connection options require remoteAddress",
      ),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.instrumentWithFrida, async () => {
          if (args.mode === "attach" && options.argument !== undefined)
            return projectAnalysisError(
              new AnalysisInputError(
                CLI_COMMANDS.instrumentWithFrida,
                undefined,
                [
                  {
                    path: ["argument"],
                    reason: "invalid_value",
                    message:
                      "--argument is only valid in spawn mode; remove it when attaching to a process.",
                  },
                ],
              ),
            );
          if (
            (options.script === undefined) ===
            (options.scriptFile === undefined)
          )
            return projectAnalysisError(
              new AnalysisInputError(
                CLI_COMMANDS.instrumentWithFrida,
                undefined,
                [
                  {
                    path: ["script"],
                    reason: "invalid_value",
                    message:
                      "Provide exactly one of --script or --script-file.",
                  },
                ],
              ),
            );
          const pid =
            /^[0-9]+$/u.test(args.target) &&
            Number.isSafeInteger(Number(args.target)) &&
            Number(args.target) > 0
              ? Number(args.target)
              : undefined;
          if (args.mode === "attach" && pid === undefined)
            return projectAnalysisError(
              new AnalysisInputError(
                CLI_COMMANDS.instrumentWithFrida,
                undefined,
                [
                  {
                    path: ["target"],
                    reason: "invalid_value",
                    message: "attach mode needs a positive integer process ID.",
                  },
                ],
              ),
            );
          const captureLimits = Object.fromEntries(
            Object.entries({
              session_bytes: options.captureSessionBytes,
              message_text_bytes: options.captureMessageTextBytes,
              message_type_bytes: options.captureMessageTypeBytes,
              json_nodes: options.captureJsonNodes,
              json_depth: options.captureJsonDepth,
            }).filter(([, value]) => value !== undefined),
          );
          const candidate = {
            mode: args.mode,
            ...(args.mode === "attach"
              ? { pid }
              : {
                  program: args.target,
                  ...(options.argument === undefined
                    ? {}
                    : { argv: options.argument }),
                }),
            ...(options.deviceId === undefined
              ? options.remoteAddress === undefined
                ? { device_id: "local" }
                : {}
              : { device_id: options.deviceId }),
            ...(options.remoteAddress === undefined
              ? {}
              : {
                  remote: {
                    address: options.remoteAddress,
                    token: options.token,
                    certificate: options.certificate,
                    origin: options.origin,
                    keepalive_interval: options.keepaliveInterval,
                  },
                }),
            ...(Object.keys(captureLimits).length === 0
              ? {}
              : { capture_limits: captureLimits }),
            ...(options.scriptFile === undefined
              ? { source_kind: "inline", source: options.script }
              : { source_kind: "file", path: options.scriptFile }),
            duration_ms: options.durationMs,
          };
          // The contract admits the request MCP would send.
          const admitted = instrumentContract.inputSchema.safeParse(candidate);
          if (!admitted.success)
            return projectAnalysisError(
              analysisInputErrorFromIssues(
                instrumentContract.name,
                admitted.error.issues,
                candidate,
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
            "instrument_with_frida",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};
