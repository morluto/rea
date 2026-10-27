import spawn from "cross-spawn";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  ProviderProcessSupervisor,
  type ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { err, ok, type Result } from "../domain/result.js";
import { UpdateCommandProgress } from "./UpdateCommandProgress.js";
import type { UpdateOutput } from "./Update.js";
import { withoutPackageRunnerIdentity } from "./ClientRegistrationIdentity.js";

export const UPDATE_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const UPDATE_PROBE_TIMEOUT_MS = 10_000;

/** Own metadata subprocesses through cancellation, final collection and cleanup retry. */
export class UpdateCommandRunner {
  readonly #resources = new ArtifactResourceScope();
  readonly #controller = new AbortController();
  constructor(private readonly probeTimeoutMs = UPDATE_PROBE_TIMEOUT_MS) {}

  async runProbe(
    command: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    output: UpdateOutput = "structured",
    workingDirectory?: string,
  ): Promise<Result<string, string>> {
    if (this.#controller.signal.aborted)
      return err("Update command runner is closed.");
    const deadline = new ProviderStartupDeadline(
      this.probeTimeoutMs,
      this.#controller.signal,
    );
    try {
      return await this.#resources.run(() =>
        runUpdateProcess(
          command,
          environment,
          output,
          workingDirectory,
          "complete",
          this.#resources,
          deadline,
        ),
      );
    } catch (cause: unknown) {
      return err(cause instanceof Error ? cause.message : String(cause));
    } finally {
      deadline.dispose();
    }
  }

  async runInstall(
    command: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    output: UpdateOutput,
    workingDirectory?: string,
  ): Promise<Result<string, string>> {
    if (this.#controller.signal.aborted)
      return err("Update command runner is closed.");
    return this.#resources
      .run(() =>
        runUpdateProcess(
          command,
          environment,
          output,
          workingDirectory,
          "diagnostics",
          this.#resources,
        ),
      )
      .catch((cause: unknown) =>
        err(cause instanceof Error ? cause.message : String(cause)),
      );
  }

  close(): Promise<void> {
    this.#controller.abort(new Error("Update command runner closed."));
    return this.#resources.close();
  }
}

const runUpdateProcess = async (
  command: readonly string[],
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  output: UpdateOutput,
  workingDirectory: string | undefined,
  retention: "complete" | "diagnostics",
  resources: ArtifactResourceScope,
  probe?: ProviderStartupDeadline,
): Promise<Result<string, string>> => {
  if (probe?.signal.aborted)
    return err("Update metadata probe cancelled before launch.");
  const [executable, ...args] = command;
  if (executable === undefined) return err("No executable supplied.");
  const environment = withoutPackageRunnerIdentity(selectedEnvironment);
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
    windowsHide: true,
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
  });
  let processFailure: string | undefined;
  const supervisor = new ProviderProcessSupervisor(
    { process: child, ownsProcessLifetime: true },
    {
      maxDiagnosticBytes: UPDATE_COMMAND_OUTPUT_BYTES,
      onDiagnostic: (event) => {
        if (event.type === "error") processFailure ??= event.message;
      },
    },
  );
  const progress =
    output === "human" ? new UpdateCommandProgress(process.stderr) : undefined;
  if (progress !== undefined) {
    for (const stream of [child.stdout, child.stderr])
      if (stream !== null) progress.pipe(stream);
  }
  let retained = false;
  try {
    // Drain even an oversized reply. Verbosity must not interrupt a package install.
    // Keep the existing launch/signal policy; this collector owns no process-tree authority.
    const completed = await supervisor.waitForOutputClose(
      undefined,
      probe?.signal,
    );
    let interrupted: string | undefined;
    if (!completed) {
      interrupted =
        probe?.interruption === "timeout"
          ? `Update metadata probe timed out after ${String(probe.timeoutMs)} ms.`
          : "Update metadata probe cancelled.";
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete") {
        retained = true;
        resources.retain({
          kind: "lease",
          resource: executable,
          lease: {
            release: async () => {
              const retried = await supervisor.stop();
              if (retried.status === "incomplete")
                throw new Error(retried.reason);
            },
          },
        });
        interrupted += ` Cleanup incomplete: ${stopped.reason}`;
      }
    }
    const progressFailure = await progress?.close();
    const snapshot = supervisor.snapshot();
    if (processFailure !== undefined)
      return err(
        probeFailureDetail(
          interrupted === undefined
            ? processFailure
            : `${processFailure} ${interrupted}`,
          snapshot,
        ),
      );
    if (interrupted !== undefined)
      return err(probeFailureDetail(interrupted, snapshot));
    if (snapshot.outputIncomplete === true)
      return err("Update command output did not close completely.");
    if (retention === "complete" && snapshot.diagnosticTruncated === true)
      return err(
        `Update command output exceeded the ${UPDATE_COMMAND_OUTPUT_BYTES}-byte complete-output retention budget; reply was not accepted.`,
      );
    if (snapshot.exitCode !== 0 || snapshot.signal !== null) {
      const detail =
        snapshot.stderr.text.trim() ||
        snapshot.stdout.text.trim() ||
        (typeof snapshot.signal === "string"
          ? `Process terminated by ${snapshot.signal}.`
          : typeof snapshot.exitCode === "number"
            ? `Process exited with code ${snapshot.exitCode}.`
            : "Update command failed without a recorded exit status.");
      return err(
        snapshot.diagnosticTruncated
          ? `${detail}\n[Update diagnostics truncated at ${UPDATE_COMMAND_OUTPUT_BYTES} bytes; later output omitted.]`
          : detail,
      );
    }
    if (
      retention === "complete" &&
      (snapshot.stdout.invalidUtf8 || snapshot.stderr.invalidUtf8)
    )
      return err(
        "Update command returned invalid UTF-8; complete output is unavailable.",
      );
    if (progressFailure !== undefined)
      return err(`Update progress output failed: ${progressFailure.message}`);
    if (probe?.interruption !== undefined)
      return err(
        probeFailureDetail(
          probe.interruption === "timeout"
            ? `Update metadata probe timed out after ${String(probe.timeoutMs)} ms.`
            : "Update metadata probe cancelled.",
          snapshot,
        ),
      );
    return ok(retention === "diagnostics" ? "" : snapshot.stdout.text.trim());
  } finally {
    // Failed stop ownership stays on the runner for a later cleanup attempt.
    if (!retained) supervisor.dispose();
    await progress?.close();
  }
};

const probeFailureDetail = (
  reason: string,
  snapshot: ProviderProcessSnapshot,
): string =>
  [
    reason,
    snapshot.stdout.text === "" ? "" : `stdout: ${snapshot.stdout.text}`,
    snapshot.stderr.text === "" ? "" : `stderr: ${snapshot.stderr.text}`,
    snapshot.diagnosticTruncated ? "[Update diagnostics truncated.]" : "",
    snapshot.outputIncomplete
      ? "[Update output did not close completely.]"
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
