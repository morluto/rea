import { createInterface, type Interface } from "node:readline";

import { z } from "incur";
import type { Logger } from "pino";

import { captureDesktopApplication } from "../application/desktop/DesktopApplicationCapture.js";
import type { DesktopStateReaders } from "../application/desktop/DesktopApplicationState.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { DESKTOP_CAPTURE_DEFAULTS } from "../domain/desktop/desktopCapture.js";
import type { SessionRequest } from "../desktop/DesktopApplicationSession.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

const positive = (fallback: number) => z.int().positive().default(fallback);

/** Options of `capture-desktop-application`. */
const captureOptions = z.object({
  desktopEntry: z
    .string()
    .optional()
    .describe("Desktop entry id (org.xfce.mousepad) or absolute .desktop path"),
  executable: z
    .string()
    .optional()
    .describe(
      "Executable path or program name on PATH, instead of a desktop entry",
    ),
  argument: z
    .array(z.string())
    .optional()
    .describe("Argument appended to the launch command (repeatable)"),
  output: z
    .string()
    .describe("New or empty directory for capture.json and retained content"),
  statePath: z
    .array(z.string())
    .optional()
    .describe(
      "File or directory whose starting content is retained in addition to the application's state directories (repeatable)",
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Path left out of every checkpoint walk (repeatable)"),
  maxDurationSeconds: positive(
    DESKTOP_CAPTURE_DEFAULTS.maxDurationSeconds,
  ).describe("Stop the session after this many seconds"),
  maxEntries: positive(DESKTOP_CAPTURE_DEFAULTS.maxEntries).describe(
    "Maximum paths recorded per checkpoint walk",
  ),
  maxFileBytes: positive(DESKTOP_CAPTURE_DEFAULTS.maxFileBytes).describe(
    "Largest file whose content is retained",
  ),
  maxContentBytes: positive(DESKTOP_CAPTURE_DEFAULTS.maxContentBytes).describe(
    "Total retained content",
  ),
});

const QUEUE_PAUSE = 16;
const QUEUE_RESUME = 4;

/**
 * Requests read from stdin. Reading pauses while many are queued, so a fast
 * driver cannot grow the queue without bound.
 */
class SessionRequestQueue {
  readonly #requests: SessionRequest[] = [];
  #paused = false;

  constructor(readonly lines: Interface) {
    lines.on("line", (line) => {
      this.#requests.push(parseSessionRequest(line));
      if (!this.#paused && this.#requests.length >= QUEUE_PAUSE) {
        this.#paused = true;
        lines.pause();
      }
    });
  }

  next(): SessionRequest | undefined {
    const request = this.#requests.shift();
    if (this.#paused && this.#requests.length <= QUEUE_RESUME) {
      this.#paused = false;
      this.lines.resume();
    }
    return request;
  }

  close(): void {
    this.lines.close();
  }
}

/** `stop` ends the session; any other line, empty or not, names a checkpoint. */
export const parseSessionRequest = (line: string): SessionRequest => {
  const text = line.trim();
  if (text === "stop") return { kind: "stop" };
  const name = text.replace(/^checkpoint\b\s*/u, "");
  return { kind: "checkpoint", name: name.length === 0 ? undefined : name };
};

/**
 * Run with SQLite and dconf readers for the state view and the export. They
 * are loaded here, so registering the command catalog never loads them.
 */
const withStateReaders = async <Value>(
  environment: NodeJS.ProcessEnv,
  run: (readers: DesktopStateReaders) => Promise<Value>,
): Promise<Value> => {
  const [
    { createSqliteDatabaseService },
    { readSqliteStateView },
    { dumpDconfDatabase },
  ] = await Promise.all([
    import("../composition/sqlite.js"),
    import("../application/desktop/DesktopSqliteState.js"),
    import("../desktop/DconfDatabaseReader.js"),
  ]);
  const sqlite = createSqliteDatabaseService(environment);
  try {
    return await run({
      sqlite: (database, writeAheadLog, signal) =>
        readSqliteStateView(sqlite, database, writeAheadLog, signal),
      dconf: (database, signal) =>
        dumpDconfDatabase(database, environment, signal),
    });
  } finally {
    await sqlite.close();
  }
};

/** Register the export of a capture folder as a computer app bundle. */
const registerDesktopExportCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: NodeJS.ProcessEnv,
): void => {
  cli.command(CLI_COMMANDS.exportDesktopApplication, {
    description:
      "Export a desktop application capture folder as an agentenv computer app bundle: class, env.toml, skill and seed",
    args: z.object({
      capture: z
        .string()
        .describe("Folder written by capture-desktop-application"),
      directory: z.string().describe("New or empty bundle directory"),
    }),
    options: z.object({
      name: z
        .string()
        .optional()
        .describe(
          "Environment name; defaults to one derived from the application",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.exportDesktopApplication,
          async () => {
            const { exportDesktopApplication } =
              await import("../application/desktop/DesktopApplicationExport.js");
            const result = await withStateReaders(environment, (readers) =>
              exportDesktopApplication(
                {
                  capture: absoluteCallerPath(args.capture),
                  directory: absoluteCallerPath(args.directory),
                  name: options.name,
                },
                readers,
                signal,
              ),
            );
            return result instanceof AnalysisError
              ? {
                  error: "Desktop export failed",
                  ...projectAnalysisError(result),
                }
              : result;
          },
        ),
      ),
  });
};

/** Register the state view over a capture folder. */
const registerDesktopStateCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: NodeJS.ProcessEnv,
): void => {
  cli.command(CLI_COMMANDS.inspectDesktopApplicationState, {
    description:
      "Read a desktop application capture folder into the application's state: roles, typed JSON views of each version and kinds of change",
    args: z.object({
      capture: z
        .string()
        .describe("Folder written by capture-desktop-application"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectDesktopApplicationState,
          async () => {
            const { inspectDesktopApplicationState } =
              await import("../application/desktop/DesktopApplicationState.js");
            const result = await withStateReaders(environment, (readers) =>
              inspectDesktopApplicationState(
                absoluteCallerPath(args.capture),
                readers,
                signal,
              ),
            );
            return result instanceof AnalysisError
              ? {
                  error: "Desktop state view failed",
                  ...projectAnalysisError(result),
                }
              : result;
          },
        ),
      ),
  });
};

/** Register the interactive Linux desktop application capture. */
export const registerDesktopCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: NodeJS.ProcessEnv,
): void => {
  registerDesktopStateCommand(cli, logger, environment);
  registerDesktopExportCommand(cli, logger, environment);
  cli.command(CLI_COMMANDS.captureDesktopApplication, {
    description:
      "Launch a Linux desktop application, watch it while it is used and record its windows and state at checkpoints read from stdin",
    options: captureOptions,
    run: ({ options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.captureDesktopApplication,
          async () => {
            const requests = new SessionRequestQueue(
              createInterface({ input: process.stdin, terminal: false }),
            );
            try {
              return await captureDesktopApplication(
                {
                  desktopEntry: options.desktopEntry,
                  executable: options.executable,
                  arguments: options.argument ?? [],
                  output: options.output,
                  statePaths: options.statePath ?? [],
                  excludes: options.exclude ?? [],
                  maxDurationSeconds: options.maxDurationSeconds,
                  maxEntries: options.maxEntries,
                  maxFileBytes: options.maxFileBytes,
                  maxContentBytes: options.maxContentBytes,
                },
                {
                  platform: process.platform,
                  environment,
                  callerDirectory: process.cwd(),
                  nextRequest: () => requests.next(),
                  report: async (message) => {
                    process.stderr.write(
                      `${JSON.stringify({ rea_progress: { phase: "desktop_capture", message } })}\n`,
                    );
                  },
                },
                signal,
              );
            } finally {
              requests.close();
            }
          },
        ),
      ),
  });
};
