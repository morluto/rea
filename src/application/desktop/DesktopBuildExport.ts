import { Readable } from "node:stream";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { desktopTaskSchema } from "../../domain/desktop/appTask.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  fetchHomeFolder,
  type ControlledComputer,
} from "../../desktop/BuildComputerController.js";
import {
  adapterError,
  ENDS,
  errorText,
  readOutput,
  refused,
  runRea,
} from "./DesktopBuildCommands.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";

const EXPORT = "export_build_environment";
/** The most bytes the task takes in the controller's one JSON argument, which Linux caps at 128 KiB. */
const TASK_ARGUMENT_BYTES = 96 * 1024;

const exportResultSchema = z.looseObject({
  environment: z.string(),
  seed_files: z.array(z.string()),
  scrubbed_files: z.array(z.string()),
  unscrubbed_files: z.array(z.string()),
  limitations: z.array(z.string()),
  task: jsonValueSchema,
});

/** What the agent asks the export for: its task, the folder here and, optionally, the environment's name. */
export interface BuildExportRequest {
  readonly task: z.output<typeof desktopTaskSchema>;
  readonly directory: string;
  readonly name?: string | undefined;
}

/** An exported bundle brought back to this host. */
export type ExportedBuild = {
  readonly directory: string;
  readonly environment: string;
  readonly files: number;
  readonly bytes: number;
  readonly task: JsonValue;
  readonly seed_files: string[];
  readonly scrubbed_files: string[];
  readonly unscrubbed_files: string[];
  readonly limitations: string[];
};

/**
 * Bring the bundle back straight into the caller's new or empty folder, each
 * checked answer written before the next is fetched; a failure leaves no
 * partial folder.
 */
const writeBundle = async (
  computer: ControlledComputer,
  bundle: string,
  directory: string,
  signal: AbortSignal,
): Promise<
  Result<{ readonly files: number; readonly bytes: number }, AnalysisError>
> => {
  let fetched = { files: 0, bytes: 0 };
  const unclosed = await writeOutputTree(
    directory,
    async (tree) => {
      fetched = await fetchHomeFolder(
        computer,
        bundle,
        {
          file: async (file) => {
            await tree.write(
              file.path,
              Readable.from([file.bytes]),
              { bytes: file.bytes.length, sha256: file.sha256 },
              signal,
            );
          },
        },
        signal,
      );
    },
    { operation: EXPORT, field: "directory" },
    signal,
  );
  return unclosed === undefined
    ? ok(fetched)
    : err(
        writtenWithOpenHandles(
          { provider: AGENTENV_PROVIDER, operation: EXPORT, what: "bundle" },
          directory,
          unclosed,
        ),
      );
};

/**
 * Export a stopped capture in the computer with the agent's task, seeded at
 * `seed` and checked at `end`, into a new folder of the work folder, then
 * bring the bundle back and write it into the caller's folder. A task the
 * export refuses is refused with the export's own reason.
 */
export const exportBuild = async (
  computer: ControlledComputer,
  capture: {
    readonly folder: string;
    readonly attempt: number;
    /** The URL a computer downloads the app's `.deb` from, when the capture says apt does not install it. */
    readonly packageUrl?: string;
  },
  request: BuildExportRequest,
  signal: AbortSignal,
): Promise<Result<ExportedBuild, AnalysisError>> => {
  const { folder } = capture;
  const attempt = String(capture.attempt);
  const bundle = `${folder}/bundle-${attempt}`;
  const task = `${folder}/task-${attempt}.json`;
  const stdout = `${folder}/export-${attempt}.json`;
  const taskFile = `${JSON.stringify(request.task, null, 2)}\n`;
  const taskBytes = Buffer.byteLength(JSON.stringify(taskFile));
  if (taskBytes > TASK_ARGUMENT_BYTES)
    return err(
      refused(
        EXPORT,
        `The task takes ${String(taskBytes)} bytes in the command REA runs in the computer, more than the ${String(TASK_ARGUMENT_BYTES)} it allows a task.`,
        "Shorten the task's prompt or checks and export again.",
      ),
    );
  try {
    const bytes = await runRea(
      computer,
      [
        "export-desktop-application",
        `${folder}/capture`,
        bundle,
        "--task",
        task,
        ...ENDS,
        // The building agent made the seed in this computer for the task.
        "--synthetic-seed",
        ...(request.name === undefined ? [] : ["--name", request.name]),
        ...(capture.packageUrl === undefined
          ? []
          : ["--package-url", capture.packageUrl]),
        "--json",
      ],
      {
        stdout,
        files: { [task]: taskFile },
        signal,
      },
    );
    const output = await readOutput(computer, stdout, bytes, signal);
    if (output.kind === "failure")
      return err(
        output.failure.code === "invalid_request"
          ? refused(
              EXPORT,
              output.failure.message,
              output.failure.remediation?.action ??
                "Rewrite the task and export again.",
            )
          : adapterError(EXPORT, output.failure.message),
      );
    const result = exportResultSchema.parse(output.result);
    const written = await writeBundle(
      computer,
      bundle,
      request.directory,
      signal,
    );
    if (!written.ok) return written;
    return ok({
      directory: request.directory,
      environment: result.environment,
      files: written.value.files,
      bytes: written.value.bytes,
      task: result.task,
      seed_files: result.seed_files,
      scrubbed_files: result.scrubbed_files,
      unscrubbed_files: result.unscrubbed_files,
      limitations: result.limitations,
    });
  } catch (cause: unknown) {
    return err(
      cause instanceof AnalysisError
        ? cause
        : adapterError(EXPORT, errorText(cause), cause),
    );
  }
};
