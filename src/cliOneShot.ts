import type { Writable } from "node:stream";

import {
  cliCompletionShell,
  isProjectScopedAmpRegistration,
  normalizeCliArguments,
  splitIncurBuiltinArguments,
} from "./cliBuiltinArguments.js";
import {
  cliConfigurationError,
  parseCliOutputArguments,
  renderCliOutputArgumentError,
  renderEmptyFilteredCliOutput,
  renderVersionReport,
} from "./cliOutput.js";
import type { VersionReportHost } from "./domain/versionReport.js";

/**
 * Process facilities one command needs. The executable binds them to its own
 * streams and exit; a driver that serves several commands from one process
 * binds them to per-command capture.
 */
export interface OneShotCliHost {
  readonly environment: NodeJS.ProcessEnv;
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
   * exit and must call `finishOutput` with the status it reports.
   */
  exit(code: number, finishOutput: (status: number) => Promise<void>): void;
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
  const isShellCompletion = cliCompletionShell(host.environment) !== undefined;
  const cliArguments = isShellCompletion
    ? [...arguments_]
    : normalizeCliArguments([...arguments_]);
  // Completion words are transport data, including partial output flags.
  const outputOptions = parseCliOutputArguments(
    isShellCompletion ? [] : cliArguments,
  );
  const outputArguments = outputOptions.validation;
  // `--version` with an explicit format reports the runtime as a document;
  // plain `--version` stays Incur's bare version string.
  const versionOutput = renderVersionReport(
    outputOptions,
    host.runtime,
    host.stdoutIsTerminal,
  );
  const configurationError = cliConfigurationError(host.environment);
  // Doctor is the readiness report for this failure. Other commands still stop
  // here so they do not run with an unusable log level.
  if (
    configurationError !== undefined &&
    (isShellCompletion ||
      splitIncurBuiltinArguments(cliArguments).command[0] !== "doctor")
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
  if (!isShellCompletion && isProjectScopedAmpRegistration(cliArguments)) {
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

  // Loaded only now: the documents above answer without the command catalog.
  const { loadCliRuntime } = await import("./cli/cliLoader.js");
  const runtime = await loadCliRuntime(cliArguments, host.environment);
  host.ownCliResources(runtime.closeCliResources);
  const { createCliResultOutput } = await import("./cli/cliResultOutput.js");
  let wroteOutput = false;
  const resultOutput = createCliResultOutput(
    outputOptions,
    host.resultDestination,
  );
  try {
    await runtime.createCli(resultOutput).serve(cliArguments, {
      stdout: (output) => {
        if (resultOutput?.handled) {
          if (resultOutput.failed && !host.stdoutClosed())
            host.writeStderr(output);
          return;
        }
        if (output.length > 0) wroteOutput = true;
        if (resultOutput?.captureSdkOutput(output)) return;
        host.writeStdout(output);
      },
      exit: (code) => {
        host.exit(typeof code === "number" ? code : 0, async (status) =>
          resultOutput?.finishSdkOutput(status),
        );
      },
    });
  } catch (cause) {
    if (wroteOutput) throw cause;
    const recovered = await resultOutput
      ?.recoverFormattingFailure(cause)
      .catch((writeFailure: unknown) => {
        // Recovery writes outside Incur's command boundary. A reader that
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
  if (!host.exitRequested())
    await resultOutput?.finishSdkOutput(host.exitCode());
};
