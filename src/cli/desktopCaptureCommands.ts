import { createInterface } from "node:readline";

import { z } from "incur";
import type { Logger } from "pino";

import { captureDesktopApplication } from "../application/desktop/DesktopApplicationCapture.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { DESKTOP_CAPTURE_DEFAULTS } from "../domain/desktop/desktopCapture.js";
import { SessionRequestQueue } from "../desktop/DesktopSessionRequests.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

const positive = (fallback: number) => z.int().positive().default(fallback);

/** Options of `capture-desktop-application`. */
const captureOptions = z.object({
  desktopEntry: z
    .string()
    .min(1)
    .optional()
    .describe("Desktop entry id (org.xfce.mousepad) or absolute .desktop path"),
  executable: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Executable path or program name on PATH, instead of a desktop entry",
    ),
  // An empty argument reaches the application as is. Path options refuse
  // one, because normalizing it would select the current directory.
  argument: z
    .array(z.string())
    .optional()
    .describe("Argument appended to the launch command (repeatable)"),
  output: z
    .string()
    .min(1)
    .describe("New or empty directory for capture.json and retained content"),
  statePath: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "File or directory whose starting content is retained in addition to the application's state directories (repeatable)",
    ),
  exclude: z
    .array(z.string().min(1))
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

/** Register the interactive Linux desktop application capture. */
export const registerDesktopCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: NodeJS.ProcessEnv,
): void => {
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
