import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  desktopApplicationCaptureSchema,
  desktopCaptureProgressSchema,
  type DesktopApplicationCapture,
} from "../../domain/desktop/desktopCapture.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import type { ControlledComputer } from "../../desktop/BuildComputerController.js";
import {
  adapterError,
  readOutput,
  type Answer,
} from "./DesktopBuildCommands.js";

const START = "start_build_capture";
/** The most lines, and characters, a message quotes from the end of the app's stderr. */
const STDERR_QUOTE = { lines: 8, characters: 800 } as const;
/** The most characters a message quotes of a program or a progress line. */
const LINE_QUOTE = 300;

/** The end of `text`, at most `limit` characters, marked when cut. */
const ending = (text: string, limit: number): string => {
  const characters = [...text.trim()];
  return characters.length <= limit
    ? characters.join("")
    : `…${characters.slice(-limit).join("")}`;
};

/** The last whole lines of the app's stderr within the quote's bounds. */
const stderrEnding = (stderr: string): string => {
  const lines = stderr.trim().split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.toReversed()) {
    const grown = size + line.length + 1;
    if (
      kept.length === STDERR_QUOTE.lines ||
      (kept.length > 0 && grown > STDERR_QUOTE.characters)
    )
      break;
    kept.unshift(line);
    size = grown;
  }
  const quoted = ending(kept.join("\n"), STDERR_QUOTE.characters);
  return kept.length < lines.length ? `…\n${quoted}` : quoted;
};

/** The capture's last progress message in a tail of its progress log, or its last line. */
const lastProgress = (progress: string | undefined): string | undefined => {
  const lines = (progress ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = desktopCaptureProgressSchema.safeParse(
        JSON.parse(lines[index] ?? ""),
      );
      if (parsed.success) return parsed.data.rea_progress.message;
    } catch {
      // A line cut by the tail, or one the capture's runtime wrote.
    }
  }
  return lines.at(-1);
};

/** Why the capture is not answering, from what the controller saw instead of the event; its output stays out of the message. */
export const notAnswered = (
  operation: string,
  answer: Answer,
): AnalysisError => {
  if (answer.error !== undefined) return adapterError(operation, answer.error);
  const last = lastProgress(answer.progress);
  const progress =
    last === undefined ? "" : ` Its last progress: ${ending(last, LINE_QUOTE)}`;
  return adapterError(
    operation,
    answer.exited === undefined
      ? `The capture did not answer in time.${progress}`
      : `The capture ended with exit status ${String(answer.exited)} before it answered.${progress}`,
  );
};

/** The app exited before it opened a window: how it exited and what it said last, with the capture's record kept as details. */
const exitedAtLaunch = (
  recorded: DesktopApplicationCapture,
  exitStatus: number,
): AnalysisError | undefined => {
  const { application, session } = recorded;
  if (
    session.end_reason !== "application_exited" ||
    session.first_window_ms !== null
  )
    return undefined;
  const { exit } = session;
  const ended =
    exit === null
      ? "ended"
      : exit.signal === null
        ? `exited with code ${String(exit.code)}`
        : `was ended by ${exit.signal}`;
  const stderr =
    session.stderr.trim() === ""
      ? "it wrote nothing to stderr"
      : `its stderr ends: ${stderrEnding(session.stderr)}`;
  return new ProviderAdapterError(AGENTENV_PROVIDER, START, {
    userMessage: `${ending(application.argv[0] ?? "The app", LINE_QUOTE)} ${ended} after ${String(session.duration_ms)} ms without opening a window; ${stderr}`,
    remediationAction:
      "The app does not run as installed: check what it needs, such as a runtime its stderr names, or install it from another source on a new build computer, and close this one.",
    diagnostics: {
      capture_exit_status: exitStatus,
      application: { argv: [...application.argv] },
      session: {
        end_reason: session.end_reason,
        duration_ms: session.duration_ms,
        exit: session.exit,
        first_window_ms: session.first_window_ms,
        stderr: session.stderr,
        stderr_truncated: session.stderr_truncated,
      },
      limitations: [...recorded.limitations],
    },
  });
};

/**
 * Why a capture's start saw no window: when the capture has ended, its own
 * output says how, such as the app exiting at launch or the capture refusing
 * to start; otherwise, or when that output cannot be read, what the
 * controller saw.
 */
export const startFailure = async (
  computer: ControlledComputer,
  folder: string,
  answer: Answer,
  signal: AbortSignal,
): Promise<AnalysisError> => {
  if (answer.exited === undefined || answer.output_bytes === undefined)
    return notAnswered(START, answer);
  try {
    const output = await readOutput(
      computer,
      `${folder}/capture.out`,
      answer.output_bytes,
      signal,
    );
    if (output.kind === "failure")
      return new ProviderAdapterError(AGENTENV_PROVIDER, START, {
        userMessage: `The capture failed before the app's window opened: ${output.failure.message}`,
        ...(output.failure.remediation === undefined
          ? {}
          : { remediationAction: output.failure.remediation.action }),
      });
    const recorded = desktopApplicationCaptureSchema.safeParse(output.result);
    return (
      (recorded.success
        ? exitedAtLaunch(recorded.data, answer.exited)
        : undefined) ?? notAnswered(START, answer)
    );
  } catch (cause: unknown) {
    if (signal.aborted)
      return cause instanceof AnalysisError
        ? cause
        : new AnalysisCancelledError(START, { cause: signal.reason });
    return notAnswered(START, answer);
  }
};
