import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  desktopApplicationCaptureSchema,
  desktopCaptureProgressSchema,
  type DesktopApplicationCapture,
} from "../../domain/desktop/desktopCapture.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import type {
  Answer,
  ControlledComputer,
} from "../../desktop/BuildComputerController.js";
import {
  adapterError,
  readOutput,
  reportedFailure,
} from "./DesktopBuildCommands.js";

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

/** Text with each declared secret replaced before a quote cuts it. */
type Redact = (text: string) => string;
const unredacted: Redact = (text) => text;

/** Why the capture is not answering, from what the controller saw instead of the event; its output stays out of the message. */
export const notAnswered = (
  operation: string,
  answer: Answer,
  redact: Redact = unredacted,
): AnalysisError => {
  if (answer.error !== undefined) return adapterError(operation, answer.error);
  const last = lastProgress(answer.progress);
  const progress =
    last === undefined
      ? ""
      : ` Its last progress: ${ending(redact(last), LINE_QUOTE)}`;
  return adapterError(
    operation,
    answer.exited === undefined
      ? `The capture did not answer in time.${progress}`
      : `The capture ended with exit status ${String(answer.exited)} before it answered.${progress}`,
  );
};

/** The step a capture that ended did not answer, as its errors name it. */
export interface CaptureStep {
  readonly operation: string;
  /** When the capture failed, after "The capture failed", such as "before checkpoint seed". */
  readonly when: string;
  /** What to do when the app itself exited and so ended the capture. */
  readonly afterAppExit: string;
}

/** The app exited and so ended the capture: how it exited and what it said last, with the capture's record kept as details. */
const appExited = (
  step: CaptureStep,
  recorded: DesktopApplicationCapture,
  exitStatus: number,
  redact: Redact,
): AnalysisError | undefined => {
  const { application, session } = recorded;
  if (session.end_reason !== "application_exited") return undefined;
  const { exit } = session;
  const ended =
    exit === null
      ? "ended"
      : exit.signal === null
        ? `exited with code ${String(exit.code)}`
        : `was ended by ${exit.signal}`;
  const window =
    session.first_window_ms === null ? " without opening a window" : "";
  const stderr =
    session.stderr.trim() === ""
      ? "it wrote nothing to stderr"
      : `its stderr ends: ${stderrEnding(redact(session.stderr))}`;
  return new ProviderAdapterError(AGENTENV_PROVIDER, step.operation, {
    userMessage: `${ending(redact(application.argv[0] ?? "The app"), LINE_QUOTE)} ${ended} after ${String(session.duration_ms)} ms${window}; ${stderr}`,
    remediationAction: step.afterAppExit,
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
 * Why a capture step got no answer. When the capture has ended, its own
 * output says how, read the same way for every step that waits on it: a
 * failure it reported, with its details, or the app exiting; otherwise, or
 * when that output cannot be read, what the controller saw.
 */
export const endedCapture = async (
  computer: ControlledComputer,
  step: CaptureStep & { readonly folder: string; readonly redact?: Redact },
  answer: Answer,
  signal: AbortSignal,
): Promise<AnalysisError> => {
  const { redact = unredacted } = step;
  if (answer.exited === undefined || answer.output_bytes === undefined)
    return notAnswered(step.operation, answer, redact);
  try {
    const output = await readOutput(
      computer,
      `${step.folder}/capture.out`,
      answer.output_bytes,
      signal,
    );
    if (output.kind === "failure")
      return reportedFailure(
        step.operation,
        output,
        `The capture failed ${step.when}: `,
      );
    const recorded = desktopApplicationCaptureSchema.safeParse(output.result);
    return (
      (recorded.success
        ? appExited(step, recorded.data, answer.exited, redact)
        : undefined) ?? notAnswered(step.operation, answer, redact)
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return cause;
    if (signal.aborted)
      return new AnalysisCancelledError(step.operation, {
        cause: signal.reason,
      });
    return notAnswered(step.operation, answer, redact);
  }
};
