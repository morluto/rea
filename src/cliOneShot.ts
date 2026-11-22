import type { Writable } from "node:stream";

import {
  cliCompletionShell,
  isProjectScopedAmpRegistration,
  parseCliGlobalArguments,
} from "./cliBuiltinArguments.js";
import {
  cliConfigurationError,
  parseCliOutputArguments,
  readCliOutputArguments,
  renderCliOutputArgumentError,
  renderEmptyFilteredCliOutput,
  renderVersionReport,
} from "./cliOutput.js";
import { HOST_PLATFORM } from "./platform/HostPlatform.js";
import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { CLI_COMMANDS } from "./contracts/cliCommandNames.js";
import type { VersionReportHost } from "./domain/versionReport.js";

/**
 * Process facilities one command needs. The executable binds them to its own
 * streams and exit; a driver that serves several commands from one process
 * binds them to per-command capture.
 */
export interface OneShotCliHost {
  readonly environment: NodeJS.ProcessEnv;
  readonly persistentUserConfig?: true;
  readonly runtime: VersionReportHost;
  readonly stdoutIsTerminal: boolean;
  /** Destination for result documents the command streams itself. */
  readonly resultDestination: Writable;
  /** Status reported after a recovered failure when the reader has closed stdout. */
  readonly closedStdoutStatus: number;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  stdoutClosed(): boolean;
  /** Status the process would report if it ended now. */
  exitCode(): number;
  setExitCode(code: number): void;
  /** Called once when the command runtime loads, before any command runs. */
  ownCliResources(close: () => Promise<void>): void;
  /**
   * The command asked to end the process with `code`. The host owns that
   * exit and must drain `finishOutput` after closing the owned resources.
   */
  exit(code: number, finishOutput: () => Promise<void>): void;
  /** Whether `exit` has run. Its host then owns the pending result write. */
  exitRequested(): boolean;
}

const AMP_PROJECT_SCOPE_REFUSAL =
  "Amp does not support project-scoped registration. Run without --no-global to register Amp globally, or select a client with project settings. No client settings were changed.";

/**
 * Run one CLI command: admit its output arguments and configuration, answer
 * the documents that need no command runtime, then dispatch. Failures the
 * command did not report propagate to the host.
 */
export const runOneShotCli = async (
  arguments_: readonly string[],
  host: OneShotCliHost,
): Promise<void> => {
  // Completion words are transport data, including partial output flags.
  const global =
    cliCompletionShell(host.environment) === undefined
      ? parseCliGlobalArguments(arguments_)
      : undefined;
  const cliArguments = global?.arguments ?? arguments_;
  const outputOptions =
    global === undefined
      ? parseCliOutputArguments([])
      : readCliOutputArguments(global);
  const outputArguments = outputOptions.validation;
  // `--version` with an explicit format reports the runtime as a document;
  // plain `--version` stays a bare version string.
  const versionOutput = renderVersionReport(
    outputOptions,
    host.runtime,
    host.stdoutIsTerminal,
  );
  const configurationError = cliConfigurationError(host.environment);
  // Only an admitted doctor can report this failure as readiness. A malformed
  // command still stops at the same configuration boundary as other commands.
  if (
    configurationError !== undefined &&
    (global?.command[0] !== "doctor" || !outputArguments.ok)
  ) {
    host.writeStderr(`${configurationError}\n`);
    host.setExitCode(1);
    return;
  }
  if (!outputArguments.ok) {
    host.writeStdout(renderCliOutputArgumentError(outputArguments));
    host.setExitCode(1);
    return;
  }
  if (versionOutput !== undefined) {
    host.writeStdout(versionOutput);
    return;
  }
  if (global !== undefined && isProjectScopedAmpRegistration(global)) {
    // Amp has global settings only. Share the parsed scope fact with the
    // registration workflow and refuse before loading the command runtime.
    //
    // A caller that asked for a structured document gets the refusal in
    // that document, through the same pre-execution error renderer the
    // output-argument branch uses; anything else keeps the plain message.
    const refusalFormat = outputOptions.format;
    if (
      refusalFormat === "json" ||
      refusalFormat === "jsonl" ||
      refusalFormat === "yaml"
    ) {
      host.writeStdout(
        renderCliOutputArgumentError({
          format: refusalFormat,
          code: "AMP_PROJECT_SCOPE_UNSUPPORTED",
          message: AMP_PROJECT_SCOPE_REFUSAL,
        }),
      );
    } else {
      host.writeStderr(`${AMP_PROJECT_SCOPE_REFUSAL}\n`);
    }
    host.setExitCode(1);
    return;
  }

  let environment = host.environment;
  let savedDefaults: ReadonlySet<string> | undefined;
  // Config owns its file access. Uninstall uses registration and cache ownership
  // independently of the saved provider defaults.
  if (
    host.persistentUserConfig === true &&
    global !== undefined &&
    global.command[0] !== CLI_COMMANDS.config &&
    global.command[0] !== CLI_COMMANDS.uninstall &&
    !global.flags.has("--help") &&
    !global.flags.has("-h") &&
    !global.flags.has("--version") &&
    !global.flags.has("-v")
  ) {
    const { loadUserConfiguration } =
      await import("./application/UserConfigurationStore.js");
    const configuration = await loadUserConfiguration(
      snapshotEnvironment(environment, HOST_PLATFORM.platform),
    );
    if (!configuration.ok) {
      const format = outputOptions.format;
      if (format === "json" || format === "jsonl" || format === "yaml")
        host.writeStdout(
          renderCliOutputArgumentError({
            format,
            code: "CONFIGURATION_INVALID",
            message: configuration.error.message,
          }),
        );
      else host.writeStderr(`${configuration.error.message}\n`);
      host.setExitCode(1);
      return;
    }
    ({ environment, savedDefaults } = configuration.value);
  }

  // Loaded only now: the documents above answer without the command catalog.
  const { loadCliRuntime } = await import("./cli/cliLoader.js");
  const runtime = await loadCliRuntime(global, environment, savedDefaults);
  host.ownCliResources(runtime.closeCliResources);
  const { createCliResultOutput, cliOutputCancellationStatus } =
    await import("./cli/cliResultOutput.js");
  let wroteOutput = false;
  const resultOutput = createCliResultOutput(
    outputOptions,
    host.resultDestination,
  );
  try {
    await runtime.createCli(resultOutput).serve([...cliArguments], {
      stdout: (output) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed && !host.stdoutClosed())
            host.writeStderr(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        host.writeStdout(output);
      },
      exit: (code) => {
        host.exit(typeof code === "number" ? code : 0, async () =>
          resultOutput?.finish(),
        );
      },
    });
  } catch (cause) {
    const cancelledStatus = cliOutputCancellationStatus(cause);
    if (cancelledStatus !== undefined) {
      host.exit(cancelledStatus, async () => resultOutput?.finish());
      return;
    }
    if (wroteOutput) throw cause;
    const recovered = await resultOutput
      ?.recoverFormattingFailure(cause)
      .catch((writeFailure: unknown) => {
        // Recovery writes outside the command boundary. A reader that
        // declined this document keeps the same quiet closed-pipe outcome.
        if (!host.stdoutClosed()) throw writeFailure;
        return true;
      });
    if (!recovered) throw cause;
    host.setExitCode(host.stdoutClosed() ? host.closedStdoutStatus : 1);
  }
  if (!wroteOutput && !resultOutput?.handled)
    host.writeStdout(renderEmptyFilteredCliOutput(outputOptions) ?? "");
  // A requested exit is finished by the host, which owns its pending write.
  if (!host.exitRequested()) await resultOutput?.finish();
};
