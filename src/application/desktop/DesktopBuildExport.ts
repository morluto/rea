import { Readable } from "node:stream";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { DownloadInstall } from "../../domain/desktop/appDownloadInstall.js";
import type { desktopTaskSchema } from "../../domain/desktop/appTask.js";
import { END_CHECKPOINT } from "../../domain/desktop/buildCapture.js";
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
  reportedFailure,
  runRea,
} from "./DesktopBuildCommands.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";

const EXPORT = "export_build_environment";
const exportResultSchema = z.looseObject({
  environment: z.string(),
  tasks: z.array(jsonValueSchema),
  seed_files: z.array(z.string()),
  scrubbed_files: z.array(z.string()),
  // An export from before gzip seeds were listed apart has none.
  recompressed_files: z.array(z.string()).default([]),
  unscrubbed_files: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** One task the export takes, with the checkpoint its end state is read at. */
interface BuildExportTask {
  readonly task: z.output<typeof desktopTaskSchema>;
  readonly end_checkpoint?: string | undefined;
}

/** What the agent asks the export for: its tasks, the folder here and, optionally, the environment's name. */
export interface BuildExportRequest {
  readonly tasks: readonly BuildExportTask[];
  readonly directory: string;
  readonly name?: string | undefined;
}

/** An exported bundle brought back to this host. */
export type ExportedBuild = {
  readonly directory: string;
  readonly environment: string;
  readonly files: number;
  readonly bytes: number;
  readonly tasks: JsonValue[];
  readonly seed_files: string[];
  readonly scrubbed_files: string[];
  readonly recompressed_files: string[];
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

/** The `--download-install` file the export reads beside the task, and its flag; neither without a download. */
const downloadInput = (
  path: string,
  install: DownloadInstall | undefined,
): {
  readonly argv: readonly string[];
  readonly files: Readonly<Record<string, string>>;
} =>
  install === undefined
    ? { argv: [], files: {} }
    : {
        argv: ["--download-install", path],
        files: { [path]: `${JSON.stringify(install, null, 2)}\n` },
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
    /** The AppImage or tarball the request unpacked the app from, which the bundle downloads too. */
    readonly downloadInstall?: DownloadInstall;
    /** The packages the request named beside the app, which the bundle installs beside it too. */
    readonly extraPackages: readonly string[];
  },
  request: BuildExportRequest,
  signal: AbortSignal,
): Promise<Result<ExportedBuild, AnalysisError>> => {
  const { folder } = capture;
  const attempt = String(capture.attempt);
  const bundle = `${folder}/bundle-${attempt}`;
  const stdout = `${folder}/export-${attempt}.json`;
  const taskFiles = Object.fromEntries(
    request.tasks.map(({ task }, index) => [
      `${folder}/task-${attempt}-${String(index + 1)}.json`,
      `${JSON.stringify(task, null, 2)}\n`,
    ]),
  );
  const download = downloadInput(
    `${folder}/download-install-${attempt}.json`,
    capture.downloadInstall,
  );
  try {
    const { stdoutBytes: bytes } = await runRea(
      computer,
      [
        "export-desktop-application",
        `${folder}/capture`,
        bundle,
        ...Object.keys(taskFiles).flatMap((path) => ["--task", path]),
        ...request.tasks.flatMap(({ task, end_checkpoint: end }) => [
          "--task-end",
          `${task.name}=${end ?? END_CHECKPOINT}`,
        ]),
        ...ENDS,
        // The building agent made the seed in this computer for the task.
        "--synthetic-seed",
        ...(request.name === undefined ? [] : ["--name", request.name]),
        ...(capture.packageUrl === undefined
          ? []
          : ["--package-url", capture.packageUrl]),
        ...download.argv,
        ...capture.extraPackages.flatMap((name) => ["--extra-package", name]),
        "--json",
      ],
      {
        stdout,
        files: { ...taskFiles, ...download.files },
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
          : reportedFailure(EXPORT, output),
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
      tasks: result.tasks,
      seed_files: result.seed_files,
      scrubbed_files: result.scrubbed_files,
      recompressed_files: result.recompressed_files,
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
