import { desktopLibraryPolicyInputSchema } from "../domain/desktop/libraryPolicy.js";
import { desktopViewPolicyInputSchema } from "../domain/desktop/desktopViewPolicy.js";
import { safeParseJson } from "../domain/safeJson.js";
import { createInterface } from "node:readline";

import { z } from "incur";
import type { Logger } from "pino";

import { captureDesktopApplication } from "../application/desktop/DesktopApplicationCapture.js";
import type { DesktopStateReaders } from "../application/desktop/DesktopApplicationState.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import type { Evidence } from "../domain/evidence.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { err, ok } from "../domain/result.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { cliDecimalField } from "./options.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import {
  DESKTOP_CAPTURE_DEFAULTS,
  type DesktopCaptureProgress,
} from "../domain/desktop/desktopCapture.js";
import { SessionRequestQueue } from "../desktop/DesktopSessionRequests.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** One coherent view policy; invalid JSON and unknown controls fail at admission. */
const viewPolicyOption = z
  .string()
  .transform((text, context) => {
    const parsed = safeParseJson(text);
    if (!parsed.ok) {
      context.addIssue({
        code: "custom",
        message: "view-policy must be a JSON object",
      });
      return z.NEVER;
    }
    return parsed.value;
  })
  .pipe(desktopViewPolicyInputSchema)
  .optional()
  .describe(
    "JSON budget overrides: file_bytes, sqlite_tables, sqlite_rows, sqlite_view_bytes, text_lines, xml_nodes, xml_depth, parsed_bytes, json_depth, zip_entries, zip_entry_bytes, zip_bytes, zip_ratio. Positive safe integers. Applies on this call and to exported readers; no restart. Does not recover bytes the capture never retained or raise Evidence/worker limits.",
  );

/** Caller-selected inventory headroom; does not raise content-retention budgets. */
const libraryPolicyOption = z
  .string()
  .transform((text, context) => {
    const parsed = safeParseJson(text);
    if (!parsed.ok) {
      context.addIssue({
        code: "custom",
        message: "library-policy must be a JSON object",
      });
      return z.NEVER;
    }
    return parsed.value;
  })
  .pipe(desktopLibraryPolicyInputSchema)
  .optional()
  .describe(
    "JSON dependency inventory budgets: libraries (default 512, also per-image DT_NEEDED entries), search_path_entries (16 distinct offsets per DT_RUNPATH/DT_RPATH kind), string_bytes (4096 per string including NUL), table_bytes (1048576 per ELF program/dynamic table). Positive safe integers; applies to this capture without restart. Does not raise content or query-output budgets.",
  );

const positive = (fallback: number) =>
  cliDecimalField(z.int().positive().default(fallback));

/** Options of `capture-desktop-application`. */
const captureOptions = z.object({
  libraryPolicy: libraryPolicyOption,
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
  output: localPathStringSchema.describe(
    "New or empty directory for capture.json and retained content",
  ),
  statePath: z
    .array(localPathStringSchema)
    .optional()
    .describe(
      "File or directory whose starting content is retained in addition to the application's state directories; a file brings its SQLite write-ahead log and rollback journal (repeatable)",
    ),
  exclude: z
    .array(localPathStringSchema)
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
  packageFile: localPathStringSchema
    .optional()
    .describe(
      "The .deb file the application was installed from; its control fields, SHA-256 and size are recorded, never the file",
    ),
});

/** The checkpoints a bundle's seed and a task's end state are read at. */
const checkpointOptions = {
  seedCheckpoint: z
    .string()
    .optional()
    .describe(
      "Checkpoint whose state seeds the bundle; the baseline by default",
    ),
  endCheckpoint: z
    .string()
    .optional()
    .describe(
      "Checkpoint whose state a task must pass on; the capture's last by default",
    ),
  withholdFrom: z
    .string()
    .optional()
    .describe(
      "Checkpoint marked before a sign-in or licence activation; files under the owned paths that changed after it, up to --withhold-to, are withheld from the seed and the draft",
    ),
  withholdTo: z
    .string()
    .optional()
    .describe("Checkpoint marked after the sign-in or licence activation"),
  withholdPath: z
    .array(z.string())
    .optional()
    .describe(
      "Home-relative file under the owned paths to withhold as sign-in or licence state, such as one written at first launch; repeat for more",
    ),
};

/** The withhold selection the checkpoint options name. */
const withholdOf = (options: {
  readonly withholdFrom?: string | undefined;
  readonly withholdTo?: string | undefined;
  readonly withholdPath?: readonly string[] | undefined;
}) => ({
  from: options.withholdFrom,
  to: options.withholdTo,
  paths: options.withholdPath ?? [],
});

/**
 * Run a desktop operation with SQLite and dconf readers, finishing through
 * the shared command owner so the result, cancellation and the SQLite
 * service's cleanup are all kept. The readers load here, so registering the
 * command catalog never loads them.
 */
const withStateReaders = async (
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  operation: string,
  run: (readers: DesktopStateReaders) => Promise<Evidence | AnalysisError>,
) => {
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
  return finishAnalysisCommand(
    async () => {
      const result = await run({
        sqlite: (database, readSignal, policy) =>
          readSqliteStateView(sqlite, database, readSignal, policy),
        dconf: (database, readSignal) =>
          dumpDconfDatabase(database, environment, readSignal),
      });
      return result instanceof AnalysisError ? err(result) : ok(result);
    },
    {
      close: async () => {
        const failures: unknown[] = [];
        try {
          await sqlite.close();
        } catch (cause: unknown) {
          failures.push(cause);
        }
        if (operation === "export_desktop_application") {
          try {
            const { OwnedWorkerRuntime } =
              await import("../process/OwnedWorkerRuntime.js");
            await OwnedWorkerRuntime.retryPending();
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          const typed = failures.map((cause) => {
            if (cause instanceof AnalysisError) return cause;
            const observation =
              cause instanceof ArtifactReaderFailure
                ? ArtifactReaderFailure.cleanupObservation(cause, [])
                : {
                    resources: [],
                    reason:
                      cause instanceof Error ? cause.message : String(cause),
                  };
            const failure = new ProviderCleanupError(
              "rea-desktop",
              observation.resources,
              { reason: observation.reason },
              { operation, cause },
            );
            bindArtifactFileCleanup(cause, failure);
            return failure;
          });
          const combined = analysisErrorWithCleanupFailure(
            typed[0]!,
            typed[1]!,
            operation,
          );
          combined.bindCleanupDependencies(typed);
          throw combined;
        }
      },
    },
    "rea-desktop",
    operation,
    signal,
  ).then(projectCliAnalysisResult);
};

/** The export's options for withheld state beyond the window: seeding it with consent, the consent file and the copy. */
const withheldExportOptions = {
  seedWithheld: z
    .boolean()
    .default(false)
    .describe(
      "Seed the withheld files after all, which needs a seed_sign_in consent in --consent",
    ),
  consent: localPathStringSchema
    .optional()
    .describe(
      "consent.json holding the person's consents, which the bundle ships",
    ),
  withheldCopy: localPathStringSchema
    .optional()
    .describe(
      "New or empty folder outside the bundle the withheld files are copied into, for whoever supplies them at run time",
    ),
};

/** The export request's withheld fields from the CLI options, paths made absolute. */
const withheldRequestOf = (
  options: Parameters<typeof withholdOf>[0] & {
    readonly seedWithheld: boolean;
    readonly consent?: string | undefined;
    readonly withheldCopy?: string | undefined;
  },
) => ({
  withhold: withholdOf(options),
  seedWithheld: options.seedWithheld,
  consent:
    options.consent === undefined
      ? undefined
      : absoluteCallerPath(options.consent),
  withheldCopy:
    options.withheldCopy === undefined
      ? undefined
      : absoluteCallerPath(options.withheldCopy),
});

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
      capture: localPathStringSchema.describe(
        "Folder written by capture-desktop-application",
      ),
      directory: localPathStringSchema.describe(
        "New or empty bundle directory",
      ),
    }),
    options: z.object({
      viewPolicy: viewPolicyOption,
      name: z
        .string()
        .optional()
        .describe(
          "Environment name; defaults to one derived from the application",
        ),
      task: z
        .array(localPathStringSchema)
        .optional()
        .describe(
          "Task file to validate against the capture and add with its verifier and eval; repeat for several tasks, each checked at its own end",
        ),
      taskEnd: z
        .array(z.string())
        .optional()
        .describe(
          "NAME=CHECKPOINT: the checkpoint task NAME's end state is read at, instead of --end-checkpoint; a checkpoint near-NAME, when taken, must fail one of its checks",
        ),
      packageUrl: z
        .string()
        .optional()
        .describe(
          "http or https URL the computer downloads the captured --package-file from when the bundle is put, for an application installed from a .deb file",
        ),
      downloadInstall: localPathStringSchema
        .optional()
        .describe(
          "JSON file naming the AppImage or tarball a build computer unpacked the application from: kind, desktop_entry, url, sha256, architecture, and a tarball's program and name",
        ),
      extraPackage: z
        .array(z.string())
        .optional()
        .describe(
          "Ubuntu 24.04 archive package installed beside the application, such as a runtime piece its package does not install; repeat for more",
        ),
      syntheticSeed: z
        .boolean()
        .default(false)
        .describe(
          "The seed was made for the task, as in a build computer, not taken from the user's own data; the README says so instead of keeping the bundle local",
        ),
      screens: localPathStringSchema
        .optional()
        .describe(
          "Folder holding checkpoint screenshots for screen-judge examples.",
        ),
      ...withheldExportOptions,
      ...checkpointOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.exportDesktopApplication,
          async () => {
            const { exportDesktopApplication } =
              await import("../application/desktop/DesktopApplicationExport.js");
            return withStateReaders(
              environment,
              signal,
              "export_desktop_application",
              (readers) =>
                exportDesktopApplication(
                  {
                    capture: absoluteCallerPath(args.capture),
                    directory: absoluteCallerPath(args.directory),
                    name: options.name,
                    tasks: (options.task ?? []).map((path) =>
                      absoluteCallerPath(path),
                    ),
                    taskEnds: options.taskEnd,
                    packageUrl: options.packageUrl,
                    downloadInstall:
                      options.downloadInstall === undefined
                        ? undefined
                        : absoluteCallerPath(options.downloadInstall),
                    extraPackages: options.extraPackage,
                    seedCheckpoint: options.seedCheckpoint,
                    endCheckpoint: options.endCheckpoint,
                    syntheticSeed: options.syntheticSeed,
                    screens:
                      options.screens === undefined
                        ? undefined
                        : absoluteCallerPath(options.screens),
                    ...withheldRequestOf(options),
                    viewPolicy: options.viewPolicy,
                  },
                  readers,
                  signal,
                ),
            );
          },
        ),
      ),
  });
};

/** Register the change summary an agent writes a task from. */
const registerDesktopTaskCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: NodeJS.ProcessEnv,
): void => {
  cli.command(CLI_COMMANDS.describeDesktopApplicationTask, {
    description:
      "Describe how a desktop application capture's files changed from the seed checkpoint to the end, with suggested checks and a task draft to complete for export-desktop-application --task",
    args: z.object({
      capture: localPathStringSchema.describe(
        "Folder written by capture-desktop-application",
      ),
    }),
    options: z.object({ ...checkpointOptions, viewPolicy: viewPolicyOption }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.describeDesktopApplicationTask,
          async () => {
            const { draftDesktopApplicationTask } =
              await import("../application/desktop/DesktopTaskDraft.js");
            return withStateReaders(
              environment,
              signal,
              "describe_desktop_application_task",
              (readers) =>
                draftDesktopApplicationTask(
                  absoluteCallerPath(args.capture),
                  readers,
                  signal,
                  {
                    seed: options.seedCheckpoint,
                    end: options.endCheckpoint,
                    withhold: withholdOf(options),
                  },
                  options.viewPolicy,
                ),
            );
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
      capture: localPathStringSchema.describe(
        "Folder written by capture-desktop-application",
      ),
    }),
    options: z.object({
      viewPolicy: viewPolicyOption,
      statePath: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Exact original captured path to inspect (repeatable); omission examines every path",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectDesktopApplicationState,
          async () => {
            const { inspectDesktopApplicationState } =
              await import("../application/desktop/DesktopApplicationState.js");
            return withStateReaders(
              environment,
              signal,
              "inspect_desktop_application_state",
              (readers) =>
                inspectDesktopApplicationState(
                  absoluteCallerPath(args.capture),
                  readers,
                  signal,
                  { viewPolicy: options.viewPolicy, paths: options.statePath },
                ),
            );
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
  registerDesktopTaskCommand(cli, logger, environment);
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
                  ...(options.libraryPolicy === undefined
                    ? {}
                    : { libraryPolicy: options.libraryPolicy }),
                  maxDurationSeconds: options.maxDurationSeconds,
                  maxEntries: options.maxEntries,
                  maxFileBytes: options.maxFileBytes,
                  maxContentBytes: options.maxContentBytes,
                  packageFile:
                    options.packageFile === undefined
                      ? undefined
                      : absoluteCallerPath(options.packageFile),
                },
                {
                  platform: process.platform,
                  environment,
                  callerDirectory: process.cwd(),
                  nextRequest: () => requests.next(),
                  report: async (message, event) => {
                    const progress: DesktopCaptureProgress = {
                      rea_progress: {
                        phase: "desktop_capture",
                        message,
                        ...(event === undefined ? {} : { event }),
                      },
                    };
                    process.stderr.write(`${JSON.stringify(progress)}\n`);
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
